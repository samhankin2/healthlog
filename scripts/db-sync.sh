#!/usr/bin/env bash
# Sync the production SQLite DB down to the local dev DB (one-way: VPS -> local).
#
#   scripts/db-sync.sh pull    snapshot the VPS DB, save it as data/prod-snapshot.db,
#                              and make it the local data/healthlog.db
#   scripts/db-sync.sh reset   restore data/healthlog.db from the saved snapshot
#                              (offline, no VPS contact) — use after making a mess
#
# It never writes to the VPS DB. The snapshot is taken with VACUUM INTO, which is
# consistent while the service is running, into a temp file that is removed
# afterwards. Stop `node server/index.js` locally before running either command.
#
# Env: DEPLOY_HOST (default 152.69.178.242), SSH_KEY (default ~/.ssh/biscuit_arena_oracle)
set -euo pipefail

HOST="${DEPLOY_HOST:-152.69.178.242}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/biscuit_arena_oracle}"
REMOTE_DB="/var/lib/healthlog/healthlog.db"
REMOTE_TMP="/tmp/healthlog-snapshot-$$.db"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${DATA_DIR:-$ROOT/data}"
LIVE="$DATA/healthlog.db"
SNAP="$DATA/prod-snapshot.db"

ssh_opts=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes)

restore() {
  rm -f "$LIVE" "$LIVE-wal" "$LIVE-shm"
  cp "$SNAP" "$LIVE"
  echo "local DB now matches the snapshot: $LIVE"
}

case "${1:-}" in
  pull)
    mkdir -p "$DATA"
    ssh "${ssh_opts[@]}" "ubuntu@$HOST" \
      "rm -f '$REMOTE_TMP' && node -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$REMOTE_DB',{readOnly:true});d.exec(\\\"VACUUM INTO '$REMOTE_TMP'\\\");d.close()\""
    scp "${ssh_opts[@]}" "ubuntu@$HOST:$REMOTE_TMP" "$SNAP.part"
    ssh "${ssh_opts[@]}" "ubuntu@$HOST" "rm -f '$REMOTE_TMP'"
    mv "$SNAP.part" "$SNAP"
    echo "saved production snapshot: $SNAP"
    restore
    ;;
  reset)
    [ -f "$SNAP" ] || { echo "no snapshot at $SNAP — run 'pull' first" >&2; exit 1; }
    restore
    ;;
  *)
    echo "usage: $0 pull|reset" >&2
    exit 2
    ;;
esac
