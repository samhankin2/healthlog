#!/bin/bash
#
# HealthLog VPS bootstrap.
#
# Runs as root on a fresh Ubuntu 24.04 Oracle Cloud instance (aarch64 or
# x86_64), either from cloud-init user_data or by hand. Safe to re-run: every
# step is guarded, and nothing that already exists with local state (the env
# file, the SQLite database) is overwritten.
#
#   sudo REPO_URL=https://github.com/samhankin2/healthlog.git \
#        PUBLIC_IP=152.69.178.242 bash deploy/bootstrap.sh
#
# What it does:
#   1. base packages, Node 24 (NodeSource), Caddy
#   2. the `ubuntu` service user, /opt/healthlog (code) and /var/lib/healthlog (data)
#   3. /etc/healthlog/healthlog.env, mode 0600, AI key left empty for the owner
#   4. git clone of the repo into /opt/healthlog (if not already there)
#   5. systemd unit `healthlog` + the deploy script at /usr/local/bin/healthlog-deploy
#      (+ the Garmin sync Python venv, deploy/garmin-setup.sh)
#   6. Caddy site healthlog.<public-ip>.sslip.io -> 127.0.0.1:8787 (free TLS)
#   7. Oracle's image-level iptables REJECT rule fixed for 80/443, and persisted
#
# Never writes a secret: the AI key is created as an empty value and filled in
# on the box by the owner.
#
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

APP_NAME="healthlog"
APP_DIR="/opt/healthlog"
DATA_DIR="/var/lib/healthlog"
ENV_DIR="/etc/healthlog"
ENV_FILE="/etc/healthlog/healthlog.env"
SERVICE="healthlog"
PORT="8787"
REPO_URL="${REPO_URL:-https://github.com/samhankin2/healthlog.git}"
BRANCH="${BRANCH:-main}"
SKIP_APT="${SKIP_APT:-0}"
LOG_FILE="/var/log/${APP_NAME}-bootstrap.log"

# Bootstrap arrives from the repo's deploy/ directory; when run over ssh from
# deploy/install-vps.sh the whole directory is staged in /tmp.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap.sh must run as root" >&2
  exit 1
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "== ${APP_NAME} bootstrap start $(date -u) =="

# ---------------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------------
if [ "$SKIP_APT" != "1" ]; then
  echo "== base packages =="
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg ufw rsync git python3 apt-transport-https

  echo "== node 24 =="
  if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 24 ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
  fi
  node --version

  echo "== caddy =="
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
      | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  caddy version
else
  echo "== SKIP_APT=1: skipping package installation =="
fi

# ---------------------------------------------------------------------------
# 2. User and directories
# ---------------------------------------------------------------------------
echo "== service user and directories =="
# The OCI Ubuntu image ships an `ubuntu` user with the SSH key from the launch
# request. Create it only on an image that does not.
if ! id -u ubuntu >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups sudo ubuntu
fi

# Code directory: owned by ubuntu so the deploy script (root) and CI (ubuntu)
# can both work with it. Data directory: outside the code dir, so a deploy or a
# rollback can never touch the database.
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
chown -R ubuntu:ubuntu "$APP_DIR"
chown -R ubuntu:ubuntu "$DATA_DIR"
chmod 0750 "$DATA_DIR"
chmod 0750 "$ENV_DIR"

# ---------------------------------------------------------------------------
# 3. Environment file (never overwritten, never contains a real key)
# ---------------------------------------------------------------------------
echo "== environment file =="
if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists - leaving it alone"
else
  cat > "$ENV_FILE" <<EOF
# HealthLog server environment. Read by systemd via EnvironmentFile=
# in deploy/healthlog.service. Mode 0600, never committed.
PORT=${PORT}
HOST=127.0.0.1
DATA_DIR=${DATA_DIR}
COMMIT_FILE=${DATA_DIR}/commit.txt
# Fill this in on the box: sudoedit ${ENV_FILE}
# The key is server-side only and must never reach the browser or the repo.
OPENCODE_API_KEY=
AI_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_MODEL_A=claude-haiku-5-5
AI_MODEL_B=gemini-4-argon
AI_JUDGE_MODEL=minimax-m3.1-flash
EOF
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "created $ENV_FILE (OPENCODE_API_KEY is empty - fill it in)"
fi

# ---------------------------------------------------------------------------
# 4. Code
# ---------------------------------------------------------------------------
echo "== application code =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH" 2>/dev/null || git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH"
  echo "updated $APP_DIR to $(git -C "$APP_DIR" rev-parse HEAD)"
else
  if git clone --quiet "$REPO_URL" "$APP_DIR"; then
    echo "cloned $REPO_URL into $APP_DIR"
  else
    echo "WARNING: could not clone $REPO_URL - create the GitHub repo, then re-run this script" >&2
  fi
fi
chown -R ubuntu:ubuntu "$APP_DIR" 2>/dev/null || true

# No npm install anywhere: the server has zero runtime dependencies and uses
# only Node built-ins. package.json is frontend-only and is not used on the box.

# ---------------------------------------------------------------------------
# 5. systemd unit + deploy script
# ---------------------------------------------------------------------------
echo "== systemd unit =="
if [ -f "$APP_DIR/deploy/healthlog.service" ]; then
  if ! cmp -s "$APP_DIR/deploy/healthlog.service" "/etc/systemd/system/${SERVICE}.service"; then
    install -m 0644 -o root -g root "$APP_DIR/deploy/healthlog.service" "/etc/systemd/system/${SERVICE}.service"
    systemctl daemon-reload
    echo "installed /etc/systemd/system/${SERVICE}.service"
  else
    echo "unit unchanged"
  fi
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  if [ -f "$APP_DIR/server/index.js" ]; then
    systemctl restart "$SERVICE"
    sleep 2
    systemctl --no-pager --lines=5 status "$SERVICE" || true
  else
    echo "WARNING: $APP_DIR/server/index.js is missing - service not started" >&2
  fi
else
  echo "WARNING: $APP_DIR/deploy/healthlog.service not found - skipping unit install" >&2
fi

echo "== deploy script =="
if [ -f "$APP_DIR/deploy/healthlog-deploy.sh" ]; then
  install -m 0755 "$APP_DIR/deploy/healthlog-deploy.sh" "/usr/local/bin/${SERVICE}-deploy"
  # A CI-installed copy must never carry CRLF, or /bin/bash^M breaks the very
  # first deploy.
  sed -i 's/\r$//' "/usr/local/bin/${SERVICE}-deploy"
  echo "installed /usr/local/bin/${SERVICE}-deploy"
else
  echo "WARNING: $APP_DIR/deploy/healthlog-deploy.sh not found - CI deploy will fail" >&2
fi

echo "== garmin sync environment =="
if [ -f "$APP_DIR/deploy/garmin-setup.sh" ]; then
  # Non-fatal: the API runs fine without it; Garmin just reports "not installed".
  bash "$APP_DIR/deploy/garmin-setup.sh" || echo "WARNING: garmin-setup failed - Garmin sync unavailable" >&2
fi

# CI logs in as ubuntu and runs the deploy script with sudo.
SUDOERS_FILE="/etc/sudoers.d/${SERVICE}-deploy"
cat > "$SUDOERS_FILE" <<EOF
# Allow the CI deploy user to run exactly one command as root.
ubuntu ALL=(root) NOPASSWD: /usr/local/bin/${SERVICE}-deploy
EOF
chmod 0440 "$SUDOERS_FILE"
if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  echo "invalid sudoers file, removing $SUDOERS_FILE" >&2
  rm -f "$SUDOERS_FILE"
fi

# ---------------------------------------------------------------------------
# 6. Caddy + TLS
# ---------------------------------------------------------------------------
echo "== https =="
# The instance metadata does not always carry the public IP (playbook 3.3), so
# fall back to the address the instance uses for outbound traffic.
PUBLIC_IP="${PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/ 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("publicIp") or d.get("ipMetadata",{}).get("publicIp") or "")' 2>/dev/null || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || curl -fsS https://ifconfig.me/ip 2>/dev/null || true)"
fi
PUBLIC_IP="$(printf '%s' "$PUBLIC_IP" | tr -d '[:space:]')"

if [ -z "$PUBLIC_IP" ]; then
  echo "WARNING: could not determine the public IP - leaving the Caddyfile alone." >&2
  echo "         Re-run with PUBLIC_IP=<ip> to configure TLS." >&2
else
  SITE_HOST="${APP_NAME}.${PUBLIC_IP}.sslip.io"
  echo "site: https://${SITE_HOST}"

  TEMPLATE="$SCRIPT_DIR/Caddyfile"
  # install-vps.sh stages only deploy/*.sh plus Caddyfile; if this run came from
  # cloud-init with just bootstrap.sh, fall back to the repo copy.
  if [ ! -f "$TEMPLATE" ] && [ -f "$APP_DIR/deploy/Caddyfile" ]; then
    TEMPLATE="$APP_DIR/deploy/Caddyfile"
  fi

  if [ -f "$TEMPLATE" ]; then
    TMP_CADDY="$(mktemp)"
    sed "s/__PUBLIC_IP__/${PUBLIC_IP}/g" "$TEMPLATE" > "$TMP_CADDY"
    if cmp -s "$TMP_CADDY" /etc/caddy/Caddyfile 2>/dev/null; then
      echo "Caddyfile unchanged"
      rm -f "$TMP_CADDY"
    else
      install -m 0644 -o root -g root "$TMP_CADDY" /etc/caddy/Caddyfile
      rm -f "$TMP_CADDY"
      echo "installed /etc/caddy/Caddyfile for ${SITE_HOST}"
      caddy validate --config /etc/caddy/Caddyfile
      # restart, not reload: on a fresh box the packaged service is not running.
      systemctl enable caddy >/dev/null 2>&1 || true
      systemctl restart caddy
      echo "caddy restarted - the certificate takes a few seconds"
    fi
  else
    echo "WARNING: Caddyfile template not found - TLS not configured" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 7. Firewall
# ---------------------------------------------------------------------------
echo "== firewall =="
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

# Oracle's Ubuntu image installs a REJECT rule ahead of the ufw chains, so
# `ufw allow 80` appears to do nothing and both Let's Encrypt challenges fail
# with "Error getting validation data" (playbook 3.1). Insert the accepts
# before that rule and persist them across reboots.
for PORT_OPEN in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$PORT_OPEN" -j ACCEPT 2>/dev/null; then
    if [ "$PORT_OPEN" = "80" ]; then
      iptables -I INPUT 4 -p tcp --dport "$PORT_OPEN" -j ACCEPT
    else
      iptables -I INPUT 5 -p tcp --dport "$PORT_OPEN" -j ACCEPT
    fi
    echo "inserted ACCEPT for tcp/$PORT_OPEN"
  else
    echo "ACCEPT for tcp/$PORT_OPEN already present"
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save || true
else
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4 || true
  echo "wrote /etc/iptables/rules.v4 (install iptables-persistent to load it at boot)"
fi

# ---------------------------------------------------------------------------
# 8. Local check
# ---------------------------------------------------------------------------
echo "== health =="
if systemctl is-active --quiet "$SERVICE"; then
  echo "$SERVICE: active"
  curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" || echo "(health endpoint not answering yet)"
  echo
else
  echo "$SERVICE is not running - check: journalctl -u $SERVICE -n 50" >&2
fi

echo "== ${APP_NAME} bootstrap done $(date -u) =="
echo
echo "Next steps:"
echo "  1. Fill in the AI key:        sudoedit ${ENV_FILE}   (OPENCODE_API_KEY=...)"
echo "     then:                      sudo systemctl restart ${SERVICE}"
echo "  2. Open TCP 80/443 in the Oracle security list attached to the public subnet"
echo "     (Networking > VCN > Subnet > Security lists) - the iptables fix above is separate."
echo "  3. Create an invite code:     cd ${APP_DIR} && node server/cli.js invite create --note \"you\""
echo "  4. Check TLS:                 curl https://${APP_NAME}.<ip>.sslip.io/api/health"
echo
echo "Logs: journalctl -u ${SERVICE} -f"
echo "Bootstrap log: ${LOG_FILE}"
