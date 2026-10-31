#!/bin/bash
#
# Deploy HealthLog to the Oracle VPS.
#
# Pulls the latest main branch, restarts the systemd service, health-checks it,
# and rolls back to the previous commit if the new one does not come up.
#
# Installed on the VPS as /usr/local/bin/healthlog-deploy (root-owned, 0755),
# run as root by CI:
#
#   ssh -i deploy_key ubuntu@<host> "sudo /usr/local/bin/healthlog-deploy"
#
# That first install is manual and one-time: the run that introduces a change
# to this script cannot refresh the copy it is executing, so after a successful
# deploy the script copies its own repository version over the installed copy
# (see refresh_self below). From then on it keeps itself in step.
#
# Deliberately NO `npm ci`: the server has zero runtime dependencies and uses
# only Node built-ins. The package.json in this repo is frontend-only and is
# never needed on the box.
#
set -euo pipefail
umask 022

APP_DIR="/opt/healthlog"
DATA_DIR="/var/lib/healthlog"
SERVICE="healthlog"
BRANCH="main"
HEALTH_URL="http://127.0.0.1:8787/api/health"
COMMIT_FILE="${COMMIT_FILE:-/var/lib/healthlog/commit.txt}"
INSTALLED_SCRIPT="/usr/local/bin/healthlog-deploy"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-15}"

log() { echo "[healthlog-deploy $(date -u '+%H:%M:%S')] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "healthlog-deploy must run as root (use: sudo $0)" >&2
  exit 1
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "$APP_DIR is not a git checkout - run deploy/bootstrap.sh first" >&2
  exit 1
fi

cd "$APP_DIR"

# Record the currently deployed commit. This is the rollback target, so it must
# be read before anything moves.
PREV_SHA="$(git rev-parse HEAD)"
log "current commit: $PREV_SHA"

log "fetching origin/$BRANCH"
git fetch --quiet --prune origin "$BRANCH"

# Compare COMMITS, not trees: `git diff --quiet HEAD origin/main` would report
# "already up to date" after a revert that restores identical content, and the
# box would silently stay on the old commit forever (playbook 5.3).
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$REMOTE_SHA" != "$PREV_SHA" ]; then
  log "updating to origin/$BRANCH ($REMOTE_SHA)"
  if ! git checkout --quiet "$BRANCH" 2>/dev/null; then
    git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  fi
  # Fast-forward only. If the box has diverged something is wrong, so fail
  # loudly instead of inventing a merge.
  git merge --ff-only --quiet "origin/$BRANCH"
  NEW_SHA="$(git rev-parse HEAD)"
  log "deployed commit: $NEW_SHA"
else
  log "already up to date, restarting anyway"
  NEW_SHA="$PREV_SHA"
fi

rollback() {
  log "health check failed -> rolling back to $PREV_SHA"
  git reset --hard --quiet "$PREV_SHA"
  mkdir -p "$(dirname "$COMMIT_FILE")"
  printf '%s\n' "$PREV_SHA" > "$COMMIT_FILE"
  systemctl restart "$SERVICE" || true
  sleep 3
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "rollback succeeded, service is healthy on $PREV_SHA"
  else
    log "ROLLBACK FAILED - service is not healthy on $PREV_SHA"
  fi
  exit 1
}

# Copy the repository version of this script over the installed copy. Write to
# a temporary file and rename, so replacing the file while it is being executed
# is atomic and never corrupts the running copy.
refresh_self() {
  local src="$APP_DIR/deploy/healthlog-deploy.sh"
  local tmp="${INSTALLED_SCRIPT}.new"
  if [ ! -f "$src" ]; then
    return 0
  fi
  if cmp -s "$src" "$INSTALLED_SCRIPT"; then
    return 0
  fi
  # Run as root, so the installed file is root-owned without naming the user.
  install -m 0755 "$src" "$tmp"
  mv -f "$tmp" "$INSTALLED_SCRIPT"
  log "refreshed $INSTALLED_SCRIPT from $src"
}

log "restarting $SERVICE"

# Record what is deployed so GET /api/health can report it. The file lives
# outside the code directory, so deploys and rollbacks never touch the data.
mkdir -p "$(dirname "$COMMIT_FILE")"
printf '%s\n' "$NEW_SHA" > "$COMMIT_FILE"

systemctl restart "$SERVICE"

log "health checking $HEALTH_URL"
for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    log "healthy after ${attempt}s: $body"
    if ! printf '%s' "$body" | grep -q "$NEW_SHA"; then
      log "warning: health body does not report commit $NEW_SHA (check COMMIT_FILE in the env file)"
    fi
    refresh_self
    log "done on commit $NEW_SHA"
    exit 0
  fi
  sleep 1
done

rollback
