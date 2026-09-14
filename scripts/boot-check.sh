#!/usr/bin/env bash
# Starts the compiled API (backend/api/dist, exactly what the Docker image runs) in production mode against a scratch
# database with generated secrets and no external services, and requires /api/health to answer. Catches anything the
# TypeScript build leaves out of dist (a data file, a workspace-local dependency) before it reaches a server.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f backend/api/dist/index.js ] || { echo "backend/api/dist missing: run npm run build -w @bitripay/api first"; exit 1; }
TMP=$(mktemp -d)
PORT=${BOOT_CHECK_PORT:-4321}
gen() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
NODE_ENV=production PORT=$PORT DATABASE_PATH="$TMP/boot.db" JWT_SECRET=$(gen 48) APP_SECRET=$(gen 48) ADMIN_PASSWORD=$(gen 18) \
  WEB_URL=https://www.bitripay.com ADMIN_URL=https://admin.bitripay.com API_URL=https://api.bitripay.com SMTP_HOST= SMS_PROVIDER=console \
  node backend/api/dist/index.js > "$TMP/boot.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "built API answers /api/health on :$PORT"
    # pages and feeds the image serves from files next to dist (templates, brand assets, locale packs, migrations)
    for p in /api/config /api/translations/en /lite /blog /about /legal/terms /sitemap.xml /robots.txt /brand/logo.svg; do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")
      [ "$code" = "200" ] || { echo "built API: $p answered $code"; cat "$TMP/boot.log"; exit 1; }
    done
    echo "built API serves config, translations, Lite, blog, legal, sitemap, robots and brand assets"
    grep -E '^\[(compliance|config|rails)\]' "$TMP/boot.log" | head -5 || true
    exit 0
  fi
  if ! kill -0 $PID 2>/dev/null; then break; fi
  sleep 1
done
echo "built API did not become healthy; log:"
cat "$TMP/boot.log"
exit 1
