#!/usr/bin/env python3
"""
Garmin Connect fetcher for HealthLog. Run by the Node server (server/lib/garmin.js);
it never touches the database. Two commands:

  garmin_sync.py login --tokens DIR
      Interactive, run by hand over SSH. The ONLY place a full Garmin SSO login
      happens. Prompts for email, password (hidden) and MFA code, then saves
      tokens to DIR/garmin_tokens.json (0600). The password is never stored.

  garmin_sync.py fetch --tokens DIR --from YYYY-MM-DD --to YYYY-MM-DD
      Non-interactive. Resumes the saved tokens (refreshing them in place when
      they are about to expire) and prints one JSON object on stdout:
        {"ok": true, "days": [...], "activities": [...]}
        {"ok": false, "error": "needs_login" | "rate_limited" | "error", "message": "..."}
      It is constructed WITHOUT credentials, so it cannot fall back to an SSO
      login: missing or rejected tokens end in "needs_login". That keeps the
      daily job from tripping Garmin's per-IP login rate limit.

Logging goes to stderr. garminconnect tries several login strategies in order
and the first ones usually fail; those are WARNING lines, not errors.

Exit codes: 0 ok, 3 needs_login, 4 rate_limited, 1 anything else.
"""
import argparse
import getpass
import json
import logging
import os
import sys
from datetime import date, timedelta

try:
    from garminconnect import (
        Garmin,
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    )
except ImportError:  # pragma: no cover - reported to the caller as JSON
    Garmin = None

TOKEN_FILE = "garmin_tokens.json"
MAX_DAYS = 120


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(kind, message):
    emit({"ok": False, "error": kind, "message": str(message)[:500]}, {"needs_login": 3, "rate_limited": 4}.get(kind, 1))


def token_path(tokens_dir):
    return os.path.join(tokens_dir, TOKEN_FILE)


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def daterange(start, end):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def is_rate_limit(err):
    return isinstance(err, GarminConnectTooManyRequestsError) or "429" in str(err)


# --------------------------------------------------------------------------
# fetch
# --------------------------------------------------------------------------

def day_summary(client, day):
    iso = day.isoformat()
    s = client.get_user_summary(iso) or {}
    sleep_seconds = None
    try:
        sleep = client.get_sleep_data(iso) or {}
        sleep_seconds = num((sleep.get("dailySleepDTO") or {}).get("sleepTimeSeconds"))
    except (GarminConnectAuthenticationError, GarminConnectTooManyRequestsError):
        raise
    except Exception as e:  # sleep is optional; a missing night is not a failure
        logging.warning("sleep for %s unavailable: %s", iso, e)
    moderate = num(s.get("moderateIntensityMinutes"))
    vigorous = num(s.get("vigorousIntensityMinutes"))
    return {
        "day": iso,
        "steps": num(s.get("totalSteps")),
        "activeKcal": num(s.get("activeKilocalories")),
        "totalKcal": num(s.get("totalKilocalories")),
        "bmrKcal": num(s.get("bmrKilocalories")),
        "restingHr": num(s.get("restingHeartRate")),
        "sleepSeconds": sleep_seconds,
        "intensityMinutes": None if moderate is None and vigorous is None else (moderate or 0) + 2 * (vigorous or 0),
    }


def activity_row(a):
    t = a.get("activityType") or {}
    return {
        "externalId": str(a.get("activityId")),
        "name": a.get("activityName"),
        "type": t.get("typeKey"),
        "startLocal": a.get("startTimeLocal"),
        "durationS": num(a.get("duration")),
        "movingS": num(a.get("movingDuration")),
        "distanceM": num(a.get("distance")),
        "kcal": num(a.get("calories")),
        "avgHr": num(a.get("averageHR")),
        "maxHr": num(a.get("maxHR")),
        "elevationGainM": num(a.get("elevationGain")),
        "avgSpeedMps": num(a.get("averageSpeed")),
        "trainingEffect": num(a.get("aerobicTrainingEffect")),
    }


def cmd_fetch(args):
    if Garmin is None:
        fail("error", "garminconnect is not installed in this Python environment")
    try:
        start = date.fromisoformat(args.date_from)
        end = date.fromisoformat(args.date_to)
    except ValueError:
        fail("error", "--from/--to must be YYYY-MM-DD")
    if end < start or (end - start).days >= MAX_DAYS:
        fail("error", f"date range must be 1..{MAX_DAYS} days")
    if not os.path.isfile(token_path(args.tokens)):
        fail("needs_login", "No saved Garmin tokens. Run the login command once.")

    # No email/password on purpose: resume tokens only, never an SSO login.
    client = Garmin()
    try:
        client.login(args.tokens)
    except GarminConnectTooManyRequestsError as e:
        fail("rate_limited", e)
    except (GarminConnectAuthenticationError, GarminConnectConnectionError) as e:
        if is_rate_limit(e):
            fail("rate_limited", e)
        fail("needs_login", f"Saved Garmin tokens were not accepted: {e}")
    except Exception as e:
        fail("rate_limited" if is_rate_limit(e) else "error", e)

    try:
        days = [day_summary(client, d) for d in daterange(start, end)]
        raw = client.get_activities_by_date(start.isoformat(), end.isoformat()) or []
        activities = [activity_row(a) for a in raw if a.get("activityId") and a.get("startTimeLocal")]
    except GarminConnectTooManyRequestsError as e:
        fail("rate_limited", e)
    except GarminConnectAuthenticationError as e:
        fail("needs_login", e)
    except Exception as e:
        fail("rate_limited" if is_rate_limit(e) else "error", e)

    emit({"ok": True, "days": days, "activities": activities})


# --------------------------------------------------------------------------
# login (interactive)
# --------------------------------------------------------------------------

def cmd_login(args):
    if Garmin is None:
        print("garminconnect is not installed in this Python environment", file=sys.stderr)
        sys.exit(1)
    if not sys.stdin.isatty():
        print("login is interactive: run it in a terminal (ssh -t)", file=sys.stderr)
        sys.exit(1)

    if os.path.isfile(token_path(args.tokens)) and not args.force:
        # Check the existing tokens WITHOUT credentials first: no SSO hit.
        try:
            Garmin().login(args.tokens)
            print("Already logged in: the saved tokens work. Use --force to replace them.")
            return
        except Exception as e:
            print(f"Saved tokens no longer work ({e}); doing a fresh login.")

    print("Garmin login. This is the only step that sends your password to Garmin;")
    print("it is not stored. If Garmin is rate-limiting this IP (429), stop and try")
    print("again in a few hours - every attempt counts against the limit.\n")
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")

    client = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    try:
        client.login(args.tokens)  # full login, then dumps tokens to args.tokens
    except GarminConnectTooManyRequestsError as e:
        print(f"\nRate-limited by Garmin: {e}\nWait several hours before trying again.", file=sys.stderr)
        sys.exit(4)
    except Exception as e:
        print(f"\nLogin failed: {e}", file=sys.stderr)
        sys.exit(3 if not is_rate_limit(e) else 4)
    finally:
        password = None  # noqa: F841 - drop the reference

    if not os.path.isfile(token_path(args.tokens)):
        print("Login succeeded but no token file was written.", file=sys.stderr)
        sys.exit(1)
    print(f"\nLogged in. Tokens saved to {token_path(args.tokens)}; later syncs reuse them.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_login = sub.add_parser("login")
    p_login.add_argument("--tokens", required=True)
    p_login.add_argument("--force", action="store_true")
    p_fetch = sub.add_parser("fetch")
    p_fetch.add_argument("--tokens", required=True)
    p_fetch.add_argument("--from", dest="date_from", required=True)
    p_fetch.add_argument("--to", dest="date_to", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="garmin %(levelname)s %(name)s: %(message)s")
    if args.cmd == "login":
        cmd_login(args)
    else:
        cmd_fetch(args)


if __name__ == "__main__":
    main()
