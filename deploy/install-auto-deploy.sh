#!/usr/bin/env bash
# Installs the pull-based automatic deployment on the production host: a systemd timer runs deploy/auto-deploy.sh
# every 5 minutes; it deploys every new commit of the followed branch once GitHub's verify workflow is green for it.
# Usage (as root on the host, from the checkout):  bash deploy/install-auto-deploy.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
command -v flock >/dev/null || apt-get install -y util-linux
cat > /etc/systemd/system/bitripay-auto-deploy.service <<UNIT
[Unit]
Description=BitriPay automatic deployment (pull-based)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/usr/bin/env bash $DIR/deploy/auto-deploy.sh
StandardOutput=append:/var/log/bitripay-auto-deploy.log
StandardError=append:/var/log/bitripay-auto-deploy.log
UNIT
cat > /etc/systemd/system/bitripay-auto-deploy.timer <<UNIT
[Unit]
Description=Run the BitriPay automatic deployment every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now bitripay-auto-deploy.timer
echo "Installed. Follows branch: $(grep -E '^AUTO_DEPLOY_BRANCH=.+' "$DIR/deploy/.env.production" 2>/dev/null | cut -d= -f2 || git -C "$DIR" rev-parse --abbrev-ref HEAD)"
echo "Log: /var/log/bitripay-auto-deploy.log   Status: systemctl list-timers bitripay-auto-deploy.timer   Deploy now: bash deploy/auto-deploy.sh --force"
