#!/usr/bin/env bash
# Production deployment of bitripay.com: builds the three images, starts the stack behind Caddy (automatic TLS),
# waits for the API health check, then runs the go-live command inside the API container and prints the result.
# Usage: npm run deploy   (needs deploy/.env.production; see deploy/README.md for DNS and webhook registration)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/.env.production.example and fill it)"; exit 1; }
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
grep -Eq "^ACME_EMAIL=.+" "$ENV_FILE" || { echo "ACME_EMAIL is empty in $ENV_FILE (the address that receives TLS certificate notices)"; exit 1; }
docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml build
docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml up -d
echo "Waiting for the API health check…"
for i in $(seq 1 40); do
  if docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml ps api | grep -q healthy; then break; fi
  sleep 3
done
docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml exec -T api node backend/api/dist/goLive.js || true
echo
echo "Stack is up. Web https://$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2), admin https://admin.$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2), API https://api.$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)"
