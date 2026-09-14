#!/usr/bin/env bash
# Production deployment of bitripay.com: builds the three images, starts the stack behind Caddy (automatic TLS),
# waits for the API health check, then runs the go-live command inside the API container and prints the result.
# Usage: npm run deploy   (needs deploy/.env.production; see deploy/README.md for DNS and webhook registration)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/.env.production.example and fill it)"; exit 1; }
for v in JWT_SECRET APP_SECRET ADMIN_PASSWORD ACME_EMAIL; do
  grep -Eq "^$v=.+" "$ENV_FILE" || { echo "$v is empty in $ENV_FILE"; exit 1; }
done
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
