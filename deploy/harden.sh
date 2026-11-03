#!/bin/bash
#
# Host hardening for the HealthLog VPS. Idempotent; run as root.
#
#   sudo FAIL2BAN_IGNOREIP="203.0.113.0/24" bash deploy/harden.sh
#
# Called from bootstrap.sh. Deliberately does NOT touch anything the CI deploy
# depends on: the `ubuntu` user, its sudo rights, its authorized_keys, and
# port 22 being reachable from GitHub's runners all stay as they are.
#
# LOCKOUT SAFETY: when changing sshd by hand on a live box, arm an automatic
# revert first and cancel it only after a NEW ssh session works:
#
#   sudo systemd-run --unit=ssh-revert --on-active=10min /bin/sh -c \
#     'rm -f /etc/ssh/sshd_config.d/00-healthlog-hardening.conf; systemctl stop fail2ban; systemctl restart ssh'
#   ... test a fresh login ...
#   sudo systemctl stop ssh-revert.timer
#
# What it does:
#   1. sshd drop-in: no root login, only `ubuntu`, no X11/TCP/agent forwarding
#   2. fail2ban for sshd (gentle: 5 failures / 10 min -> 1 h ban)
#   3. unattended-upgrades: include the NodeSource repo, reboot at 04:00 UTC
#      when a kernel update needs it
#   4. disable services nothing here uses (rpcbind, ModemManager)
#
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then
  echo "harden.sh must run as root" >&2
  exit 1
fi

FAIL2BAN_IGNOREIP="${FAIL2BAN_IGNOREIP:-}"

# ---------------------------------------------------------------------------
# 1. sshd
# ---------------------------------------------------------------------------
# sshd uses the FIRST value it sees for each option, and sshd_config includes
# sshd_config.d/*.conf at the top in lexical order - so "00-" wins over the
# image's 50-/60- files.
echo "== sshd =="
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-healthlog-hardening.conf
TMP_SSHD="$(mktemp)"
cat > "$TMP_SSHD" <<'EOF'
# Managed by healthlog deploy/harden.sh
PermitRootLogin no
AllowUsers ubuntu
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
if cmp -s "$TMP_SSHD" "$SSHD_DROPIN"; then
  echo "sshd drop-in unchanged"
  rm -f "$TMP_SSHD"
else
  install -m 0644 -o root -g root "$TMP_SSHD" "$SSHD_DROPIN"
  rm -f "$TMP_SSHD"
  if sshd -t; then
    # Restart only the listener; existing sessions survive.
    systemctl restart ssh
    echo "sshd hardened"
  else
    echo "sshd config invalid - removing $SSHD_DROPIN" >&2
    rm -f "$SSHD_DROPIN"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. fail2ban
# ---------------------------------------------------------------------------
echo "== fail2ban =="
if ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get install -y fail2ban
fi
TMP_JAIL="$(mktemp)"
cat > "$TMP_JAIL" <<EOF
# Managed by healthlog deploy/harden.sh
[DEFAULT]
backend = systemd
banaction = iptables-multiport
ignoreip = 127.0.0.1/8 ::1 ${FAIL2BAN_IGNOREIP}

[sshd]
enabled = true
mode = normal
maxretry = 5
findtime = 10m
bantime = 1h
EOF
if cmp -s "$TMP_JAIL" /etc/fail2ban/jail.d/healthlog.local; then
  rm -f "$TMP_JAIL"
  echo "fail2ban jail unchanged"
else
  install -m 0644 -o root -g root "$TMP_JAIL" /etc/fail2ban/jail.d/healthlog.local
  rm -f "$TMP_JAIL"
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban
  echo "fail2ban configured"
fi

# ---------------------------------------------------------------------------
# 3. unattended-upgrades
# ---------------------------------------------------------------------------
echo "== unattended-upgrades =="
cat > /etc/apt/apt.conf.d/52healthlog-unattended <<'EOF'
// Managed by healthlog deploy/harden.sh
// NodeSource's Release file has "Origin: ." and suite "nodistro"; the repo is
// pinned to node_24.x, so this only ever brings Node 24 patch releases.
Unattended-Upgrade::Origins-Pattern {
        "origin=.,codename=nodistro";
};
// Reboot for kernel / libc updates at 04:00 UTC (no Garmin sync overnight).
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
echo "unattended-upgrades configured"

# ---------------------------------------------------------------------------
# 4. Unused services
# ---------------------------------------------------------------------------
echo "== unused services =="
for unit in rpcbind.socket rpcbind.service ModemManager.service; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1 && systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    echo "disabled $unit"
  fi
done

echo "== hardening done =="
