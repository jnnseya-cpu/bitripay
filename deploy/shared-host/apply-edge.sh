#!/usr/bin/env bash
# Configures the Caddy container that fronts this VPS so that bitripay.com, www.bitripay.com, admin.bitripay.com and
# api.bitripay.com reach the BitriPay containers on the shared Docker network (BITRIPAY_EDGE_NETWORK), then reloads
# it without downtime and checks the four host names through it. Run by scripts/deploy.sh at the end of a shared-host
# deployment, or by hand:  bash deploy/shared-host/apply-edge.sh
# Override the proxy container with BITRIPAY_EDGE_PROXY=<container name>. Set BITRIPAY_EDGE_AUTOCONFIG=0 in the env
# file to keep the proxy untouched (then apply deploy/shared-host/Caddyfile.container.snippet yourself).
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=deploy/.env.production
val() { grep -E "^$1=.+" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
NET="${BITRIPAY_EDGE_NETWORK:-$(val BITRIPAY_EDGE_NETWORK)}"
PROXY="${BITRIPAY_EDGE_PROXY:-$(val BITRIPAY_EDGE_PROXY)}"
[ -n "$NET" ] || { echo "BITRIPAY_EDGE_NETWORK is not set in $ENV_FILE: the BitriPay containers are not on a proxy network, nothing to configure"; exit 0; }

# 1. The proxy container: the one named, else the Caddy container attached to the edge network.
if [ -z "$PROXY" ]; then
  for c in $(docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}'); do
    img=$(docker inspect "$c" --format '{{.Config.Image}}' 2>/dev/null || true)
    if echo "$img" | grep -qi caddy; then PROXY="$c"; break; fi
  done
fi
[ -n "$PROXY" ] || { echo "No Caddy container found on network $NET. Configure your proxy by hand (deploy/README.md, shared host table) or set BITRIPAY_EDGE_PROXY."; exit 0; }
docker inspect "$PROXY" --format '{{.Config.Image}}' | grep -qi caddy || { echo "$PROXY is not a Caddy container ($(docker inspect "$PROXY" --format '{{.Config.Image}}')): configure it by hand."; exit 0; }

# 2. The Caddyfile it mounts (a file mount, or a directory mount that contains Caddyfile).
CADDYFILE_IN=""; CADDYFILE_HOST=""
while read -r dest src; do
  case "$dest" in
    /etc/caddy/Caddyfile) CADDYFILE_IN="$dest"; CADDYFILE_HOST="$src" ;;
    /etc/caddy) [ -f "$src/Caddyfile" ] && { CADDYFILE_IN="/etc/caddy/Caddyfile"; CADDYFILE_HOST="$src/Caddyfile"; } ;;
  esac
done < <(docker inspect "$PROXY" --format '{{range .Mounts}}{{.Destination}} {{.Source}}{{"\n"}}{{end}}')
[ -n "$CADDYFILE_HOST" ] && [ -f "$CADDYFILE_HOST" ] || { echo "Cannot find the Caddyfile mounted into $PROXY (expected /etc/caddy/Caddyfile). Mounts:"; docker inspect "$PROXY" --format '{{range .Mounts}}  {{.Destination}} ← {{.Source}}{{"\n"}}{{end}}'; exit 1; }

# 3. Merge the BitriPay blocks (backup first), validate inside the container, reload; restore on any failure.
BACKUP="$CADDYFILE_HOST.bak-$(date +%Y%m%d-%H%M%S)"
cp "$CADDYFILE_HOST" "$BACKUP"
echo "Proxy: $PROXY · Caddyfile: $CADDYFILE_HOST (backup $BACKUP)"
python3 deploy/shared-host/caddyfile-merge.py "$CADDYFILE_HOST" deploy/shared-host/Caddyfile.container.snippet
if ! docker exec "$PROXY" caddy validate --config "$CADDYFILE_IN" >/tmp/bitripay-caddy-validate.log 2>&1; then
  cp "$BACKUP" "$CADDYFILE_HOST"
  echo "Caddy refused the merged configuration; the previous Caddyfile was restored. Caddy said:"; cat /tmp/bitripay-caddy-validate.log
  exit 1
fi
docker exec "$PROXY" caddy reload --config "$CADDYFILE_IN"
echo "Caddy reloaded."

# 4. Check the four host names through the proxy on this machine (certificates may take a minute on first issue).
check() { curl -sk -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$1:443:127.0.0.1" "https://$1$2" || echo 000; }
for i in 1 2 3 4 5 6; do
  web=$(check www.bitripay.com /developers); api=$(check api.bitripay.com /api/health); adm=$(check admin.bitripay.com /)
  apex=$(curl -sk -o /dev/null -w '%{redirect_url}' --max-time 20 --resolve bitripay.com:443:127.0.0.1 https://bitripay.com/ || true)
  [ "$web" = 200 ] && [ "$api" = 200 ] && [ "$adm" = 200 ] && break
  sleep 10
done
echo "www.bitripay.com/developers → $web · api.bitripay.com/api/health → $api · admin.bitripay.com → $adm · bitripay.com → ${apex:-no redirect}"
if [ "$web" = 200 ] && curl -sk --max-time 20 --resolve www.bitripay.com:443:127.0.0.1 https://www.bitripay.com/developers | grep -q 'Three calls. One coffee'; then
  echo "The developers page is served by the new build through the proxy."
else
  echo "www.bitripay.com/developers does not show the new build yet: check 'docker logs $PROXY --tail 50' (certificate issue or DNS not pointing here)."
fi
getent hosts www.bitripay.com >/dev/null || echo "DNS: www.bitripay.com does not resolve from this machine; add the A record for www (same address as bitripay.com)."
