#!/usr/bin/env bash
#
# Push the deployment files to the VPS and run the bootstrap there.
#
#   ./deploy/install-vps.sh                            # uses DEPLOY_HOST / DEPLOY_USER
#   DEPLOY_HOST=152.69.178.242 ./deploy/install-vps.sh
#   ./deploy/install-vps.sh 152.69.178.242 ubuntu
#   ./deploy/install-vps.sh 152.69.178.242 ubuntu --skip-apt
#
# Environment:
#   DEPLOY_HOST   VPS IP or hostname (required, positional arg 1 wins)
#   DEPLOY_USER   ssh user, default "ubuntu"
#   SSH_KEY       private key path, default "~/.ssh/id_ed25519" if it exists
#   REPO_URL      git remote to clone on the box (default: the HealthLog repo)
#   PUBLIC_IP     override the auto-detected public IP for the Caddy hostname
#   SKIP_APT=1    (or --skip-apt) skip apt/node/caddy installation on re-runs
#
# Safe to re-run: bootstrap.sh is idempotent. It never overwrites
# /etc/healthlog/healthlog.env (so the AI key survives), never touches
# /var/lib/healthlog (the database), and only restarts Caddy when the Caddyfile
# actually changed - restarting Caddy in a loop burns Let's Encrypt's rate limit.
#
set -euo pipefail

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

HOST="${DEPLOY_HOST:-}"
USER_NAME="${DEPLOY_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-}"
SKIP_APT="${SKIP_APT:-0}"
REPO_URL="${REPO_URL:-https://github.com/samhankin2/healthlog.git}"
PUBLIC_IP_OVERRIDE="${PUBLIC_IP:-}"

POSITIONAL=0
for arg in "$@"; do
  case "$arg" in
    --skip-apt) SKIP_APT=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *)
      POSITIONAL=$((POSITIONAL + 1))
      if [ "$POSITIONAL" -eq 1 ]; then
        HOST="$arg"
      elif [ "$POSITIONAL" -eq 2 ]; then
        USER_NAME="$arg"
      else
        echo "too many arguments" >&2
        usage
      fi
      ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "DEPLOY_HOST is not set. Pass the IP as the first argument or export DEPLOY_HOST." >&2
  usage
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$SSH_KEY" ] && [ -f "$HOME/.ssh/id_ed25519" ]; then
  SSH_KEY="$HOME/.ssh/id_ed25519"
fi

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "$SSH_KEY" ]; then
  SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

REMOTE_DIR="/tmp/healthlog-deploy"
TARGET="${USER_NAME}@${HOST}"

echo "==> staging $SCRIPT_DIR -> ${TARGET}:${REMOTE_DIR}"
# A Windows checkout with core.autocrlf=true hands us CRLF files, and
# /bin/bash^M is not a valid interpreter on the box. Strip the CRs from the
# staged copies before they travel.
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
for f in bootstrap.sh healthlog-deploy.sh healthlog.service Caddyfile; do
  cp "$SCRIPT_DIR/$f" "$STAGE_DIR/$f"
  sed -i 's/\r$//' "$STAGE_DIR/$f"
done

ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR'"
scp "${SSH_OPTS[@]}" \
  "$STAGE_DIR/bootstrap.sh" \
  "$STAGE_DIR/healthlog-deploy.sh" \
  "$STAGE_DIR/healthlog.service" \
  "$STAGE_DIR/Caddyfile" \
  "${TARGET}:${REMOTE_DIR}/"

echo "==> running bootstrap (this takes a few minutes on a fresh box)"
REMOTE_ENV="REPO_URL=$(printf '%q' "$REPO_URL") SKIP_APT=$(printf '%q' "$SKIP_APT")"
if [ -n "$PUBLIC_IP_OVERRIDE" ]; then
  REMOTE_ENV="$REMOTE_ENV PUBLIC_IP=$(printf '%q' "$PUBLIC_IP_OVERRIDE")"
fi

# sudo keeps environment assignments given on its command line, which is how
# these settings reach the bootstrap without writing them to a file.
ssh "${SSH_OPTS[@]}" "$TARGET" "sudo env ${REMOTE_ENV} bash ${REMOTE_DIR}/bootstrap.sh"

echo
echo "==> local health check on the box"
ssh "${SSH_OPTS[@]}" "$TARGET" "curl -fsS --max-time 5 http://127.0.0.1:8787/api/health" || {
  echo "the API is not answering yet - check: ssh $TARGET 'sudo journalctl -u healthlog -n 50'" >&2
  exit 1
}
echo

if [ -n "$PUBLIC_IP_OVERRIDE" ]; then
  SITE="https://healthlog.${PUBLIC_IP_OVERRIDE}.sslip.io"
  echo "==> public health check"
  for _ in $(seq 1 10); do
    if curl -fsS --max-time 10 "$SITE/api/health"; then
      echo
      echo "public API healthy at $SITE"
      break
    fi
    sleep 5
  done
fi

cat <<EOF

Installed on ${HOST}.
  code           ${TARGET}:/opt/healthlog
  data+db        /var/lib/healthlog        (outside the code dir on purpose)
  env file       /etc/healthlog/healthlog.env   (mode 0600 - fill in OPENCODE_API_KEY)
  service        systemctl status healthlog
  deploy script  /usr/local/bin/healthlog-deploy  (run: sudo healthlog-deploy)
  TLS            https://healthlog.<public-ip>.sslip.io via Caddy

Still to do by hand:
  1. sudoedit /etc/healthlog/healthlog.env   -> OPENCODE_API_KEY=<your fresh key>
     sudo systemctl restart healthlog
  2. Open TCP 80/443 in the Oracle security list attached to the public subnet.
  3. ssh ${TARGET} 'cd /opt/healthlog && node server/cli.js invite create --note "you"'
EOF
