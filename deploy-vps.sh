#!/usr/bin/env bash
# =============================================================================
# deploy-vps.sh — run the WZML-X bot (the Kaggle-auto setup) on a real VPS
# =============================================================================
# Converts the Kaggle deployment to a plain Ubuntu server. On Kaggle the whole
# point was fighting the platform (12 h sessions, no public IP, tunnels). On a
# VPS none of that exists, so this script is mostly the *non*-Kaggle half of
# kaggle_notebook.py plus systemd and Caddy.
#
#   Usage:  sudo bash deploy-vps.sh yourdomain.com
#
# Tested layout: Ubuntu 22.04 / 24.04, root or sudo. Re-runnable.
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
WZML_USER="wzml"
BASE="/opt/wzml"
WZML_DIR="$BASE/WZML-X"
VENV="$BASE/venv"
LOGDIR="/var/log/wzml"

WZML_REPO="https://github.com/SilentDemonSD/WZML-X.git"
PATCHKIT_REPO="https://github.com/hackaking20/WZML-X-Bot.git"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root:  sudo bash $0 $DOMAIN"; exit 1; }
[ -n "$DOMAIN" ] || warn "No domain given — Caddy will be skipped. Pass one to enable HTTPS."

# ----------------------------------------------------------------- system deps
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  python3 python3-pip python3-venv python3-dev git ca-certificates \
  aria2 ffmpeg mediainfo p7zip-full unrar-free zip unzip wget curl jq \
  qbittorrent-nox rclone build-essential

if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    say "Installing Caddy (auto-HTTPS)"
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  fi
fi

# ------------------------------------------------------------------- user/dirs
say "Creating service user and directories"
id -u "$WZML_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$WZML_USER"
mkdir -p "$BASE" "$LOGDIR"
chown -R "$WZML_USER:$WZML_USER" "$BASE" "$LOGDIR"

# ----------------------------------------------------------------------- clone
if [ ! -d "$WZML_DIR/.git" ]; then
  say "Cloning WZML-X"
  sudo -u "$WZML_USER" git clone --depth 1 "$WZML_REPO" "$WZML_DIR"
else
  say "WZML-X already cloned — leaving it alone (update manually if you want)"
fi

# ------------------------------------------------------------------------ venv
say "Python environment"
[ -d "$VENV" ] || sudo -u "$WZML_USER" python3 -m venv "$VENV"
sudo -u "$WZML_USER" "$VENV/bin/pip" install --upgrade pip wheel
if [ -f "$WZML_DIR/requirements.txt" ]; then
  sudo -u "$WZML_USER" "$VENV/bin/pip" install -r "$WZML_DIR/requirements.txt"
else
  warn "No requirements.txt found — install WZML-X's Python deps yourself."
fi

# ---------------------------------------------------------------- patch kit
# The notebook applies this kit after cloning (user stream + web UI + auth).
# On the VPS you do it once, by hand — see README-VPS.md.
if [ ! -d "$BASE/WZML-X-Bot" ]; then
  say "Fetching the WZML-X-Bot patch kit (apply it per README-VPS.md)"
  sudo -u "$WZML_USER" git clone --depth 1 "$PATCHKIT_REPO" "$BASE/WZML-X-Bot" || \
    warn "Patch kit clone failed — fetch it manually from $PATCHKIT_REPO"
fi

# ------------------------------------------------------------------- config.env
if [ ! -f "$WZML_DIR/config.env" ]; then
  say "Writing a config.env template — FILL THIS IN before starting"
  cat > "$WZML_DIR/config.env" <<'ENVEOF'
# --- Telegram ---
BOT_TOKEN=
TELEGRAM_API=
TELEGRAM_HASH=
OWNER_ID=
DATABASE_URL=

# --- rclone ---
DEFAULT_RCLONE_CONFIG=
# --- optional ---
CMD_SUFFIX=
ENVEOF
  chown "$WZML_USER:$WZML_USER" "$WZML_DIR/config.env"
  chmod 600 "$WZML_DIR/config.env"
fi

# ----------------------------------------------------------------- systemd
say "Installing systemd units"

cat > /etc/systemd/system/aria2.service <<EOF
[Unit]
Description=aria2c RPC daemon (WZML-X)
After=network.target

[Service]
Type=simple
User=$WZML_USER
ExecStart=/usr/bin/aria2c --enable-rpc --rpc-listen-all=false \\
  --rpc-listen-port=6800 --max-connection-per-server=10 --seed-time=0 --follow-torrent=mem
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/qbittorrent.service <<EOF
[Unit]
Description=qBittorrent-nox (WZML-X)
After=network.target

[Service]
Type=simple
User=$WZML_USER
ExecStart=/usr/bin/qbittorrent-nox
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/wzml-bot.service <<EOF
[Unit]
Description=WZML-X Telegram bot
After=network-online.target aria2.service qbittorrent.service
Wants=network-online.target

[Service]
Type=simple
User=$WZML_USER
WorkingDirectory=$WZML_DIR
ExecStart=$VENV/bin/python3 -m bot
Restart=always
RestartSec=10
StandardOutput=append:$LOGDIR/bot.log
StandardError=append:$LOGDIR/bot.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# ---------------------------------------------------------------------- Caddy
if [ -n "$DOMAIN" ]; then
  say "Configuring Caddy for https://$DOMAIN"
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8080
}
EOF
  systemctl enable --now caddy
fi

say "Enabling services"
systemctl enable --now aria2.service qbittorrent.service
systemctl enable wzml-bot.service

cat <<EOF

=============================================================================
 Done. Nothing is running yet — two things first:

 1. Fill in $WZML_DIR/config.env  (bot token, API, hash, owner id, database)
 2. Apply the patch kit per README-VPS.md  (user stream + web UI + auth)

 Then start it:

     sudo systemctl start wzml-bot
     sudo journalctl -u wzml-bot -f          # live logs
     tail -f $LOGDIR/bot.log

 The web UI is on :8080, and $( [ -n "$DOMAIN" ] && echo "Caddy fronts it at https://$DOMAIN" || echo "pass a domain to get HTTPS" ).
 Bot restarts automatically on crash and on reboot — no more 12-hour sessions.
=============================================================================
EOF
