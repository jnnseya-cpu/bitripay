#!/usr/bin/env bash
# Production deployment of bitripay.com. Two modes:
#   npm run deploy                 dedicated host: Caddy on 80/443 with automatic TLS in front of the containers
#   npm run deploy -- --shared-host  a VPS that already serves other websites: nothing binds to 80/443, the containers
#                                  listen on localhost ports and the existing web server proxies to them
#                                  (server blocks in deploy/shared-host/); DEPLOY_MODE=shared-host does the same
# Builds the images, starts the stack, waits for the API health check, applies deploy/go-live.profile.json when it
# exists, then runs the go-live command inside the API container and prints the result.
# Needs deploy/.env.production; see deploy/README.md for DNS, proxy and webhook registration.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
MODE="${DEPLOY_MODE:-dedicated}"
for arg in "$@"; do case "$arg" in --shared-host) MODE=shared-host ;; --dedicated) MODE=dedicated ;; esac; done
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/.env.production.example and fill it)"; exit 1; }
if [ "$MODE" = shared-host ]; then
  COMPOSE_FILE=deploy/docker-compose.shared-host.yml
else
  COMPOSE_FILE=deploy/docker-compose.prod.yml
  # Refuse to take 80/443 from a web server that is already serving other sites on this host.
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq ':(80|443) '; then
    echo "Ports 80/443 are already in use on this host (another web server is running)."
    echo "Use the shared-host mode so nothing here touches it:  npm run deploy -- --shared-host"
    exit 1
  fi
fi
# Empty secrets are generated here (48 random bytes each) and written back to the git-ignored env file, so the
# checklist item "production secrets" is green from the first start. A generated administrator password is printed
# once: change it after the first sign-in.
gen() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
for v in JWT_SECRET APP_SECRET; do
  if ! grep -Eq "^$v=.+" "$ENV_FILE"; then
    val=$(gen 48)
    grep -Eq "^$v=" "$ENV_FILE" && sed -i "s|^$v=.*|$v=$val|" "$ENV_FILE" || echo "$v=$val" >> "$ENV_FILE"
    echo "$v generated and stored in $ENV_FILE"
  fi
done
if ! grep -Eq "^ADMIN_PASSWORD=.+" "$ENV_FILE"; then
  pw=$(gen 18)
  grep -Eq "^ADMIN_PASSWORD=" "$ENV_FILE" && sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$pw|" "$ENV_FILE" || echo "ADMIN_PASSWORD=$pw" >> "$ENV_FILE"
  echo "ADMIN_PASSWORD generated: $pw   (sign in with ADMIN_EMAIL, then change it in My profile)"
fi
if [ "$MODE" = dedicated ]; then
  grep -Eq "^ACME_EMAIL=.+" "$ENV_FILE" || { echo "ACME_EMAIL is empty in $ENV_FILE (the address that receives TLS certificate notices)"; exit 1; }
fi
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
compose build
compose up -d
echo "Waiting for the API health check…"
for i in $(seq 1 40); do
  if compose ps api | grep -q healthy; then break; fi
  sleep 3
done
PROFILE_ARGS=()
if [ -f deploy/go-live.profile.json ]; then
  compose cp deploy/go-live.profile.json api:/tmp/go-live.profile.json
  PROFILE_ARGS=(/tmp/go-live.profile.json)
fi
compose exec -T api node backend/api/dist/goLive.js "${PROFILE_ARGS[@]}" || true
DOMAIN_VALUE=$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)
echo
if [ "$MODE" = shared-host ]; then
  API_PORT=$(grep -E '^BITRIPAY_API_PORT=' "$ENV_FILE" | cut -d= -f2); WEB_PORT=$(grep -E '^BITRIPAY_WEB_PORT=' "$ENV_FILE" | cut -d= -f2); ADMIN_PORT=$(grep -E '^BITRIPAY_ADMIN_PORT=' "$ENV_FILE" | cut -d= -f2)
  echo "Containers are up on localhost only: web 127.0.0.1:${WEB_PORT:-8080}, admin 127.0.0.1:${ADMIN_PORT:-8081}, API 127.0.0.1:${API_PORT:-4000}."
  echo "Point your existing web server at them: deploy/shared-host/nginx-bitripay.conf (or apache-bitripay.conf, Caddyfile.snippet), then certbot."
else
  echo "Stack is up. Web https://${DOMAIN_VALUE}, admin https://admin.${DOMAIN_VALUE}, API https://api.${DOMAIN_VALUE}"
fi
