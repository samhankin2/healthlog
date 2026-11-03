#!/bin/bash
#
# Install / update the Python environment the Garmin sync runs in.
#
#   sudo bash /opt/healthlog/deploy/garmin-setup.sh
#
# Idempotent. Creates /opt/healthlog-garmin/venv (outside the code checkout, so
# deploys and rollbacks never touch it), installs the pinned versions from
# sync/requirements.txt, and makes the Garmin token directory under the data
# dir. Re-run after bumping the pin in sync/requirements.txt.
#
# This is the one Python dependency in HealthLog. The Node API stays
# dependency-free: it only spawns the venv's python (server/lib/garmin.js).
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/healthlog}"
VENV_ROOT="${VENV_ROOT:-/opt/healthlog-garmin}"
DATA_DIR="${DATA_DIR:-/var/lib/healthlog}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
REQS="$APP_DIR/sync/requirements.txt"

log() { echo "[garmin-setup] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "garmin-setup must run as root (use: sudo $0)" >&2
  exit 1
fi
[ -f "$REQS" ] || { echo "missing $REQS" >&2; exit 1; }

if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  log "installing python3-venv"
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
fi

if [ ! -x "$VENV_ROOT/venv/bin/python" ]; then
  log "creating $VENV_ROOT/venv"
  mkdir -p "$VENV_ROOT"
  python3 -m venv "$VENV_ROOT/venv"
fi

STAMP="$VENV_ROOT/requirements.installed"
if ! cmp -s "$REQS" "$STAMP"; then
  log "installing $(tr '\n' ' ' < "$REQS")"
  "$VENV_ROOT/venv/bin/pip" install --quiet --disable-pip-version-check --upgrade pip
  "$VENV_ROOT/venv/bin/pip" install --quiet --disable-pip-version-check -r "$REQS"
  cp "$REQS" "$STAMP"
else
  log "requirements unchanged"
fi
# Root owns the venv; the service user only needs to run it.
chmod -R go-w "$VENV_ROOT"

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/garmin"

log "python: $("$VENV_ROOT/venv/bin/python" --version)"
log "garminconnect: $("$VENV_ROOT/venv/bin/python" -c 'import importlib.metadata as m; print(m.version("garminconnect"))')"
log "done. Next (once, interactive):"
log "  ssh -t ubuntu@<ip> 'cd $APP_DIR && DATA_DIR=$DATA_DIR node server/cli.js garmin login --email <your healthlog email>'"
