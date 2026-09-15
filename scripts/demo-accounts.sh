#!/usr/bin/env bash
# Test accounts for a demonstration (customer, merchant, agent) on the running platform.
#   npm run demo-accounts -- --customer +2438… --merchant +2438… --agent +2438… [--password …] [--pin 1234]
# On a deployed host (deploy/.env.production present, containers up) the command runs inside the API container against
# the production database; elsewhere it runs against the local database. Sandbox compliance mode only.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
if [ -f "$ENV_FILE" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^bitripay-api$'; then
  MODE=$(grep -E '^DEPLOY_MODE=.+' "$ENV_FILE" | cut -d= -f2 || true); MODE="${DEPLOY_MODE:-${MODE:-shared-host}}"
  COMPOSE_FILE=deploy/docker-compose.prod.yml; [ "$MODE" = shared-host ] && COMPOSE_FILE=deploy/docker-compose.shared-host.yml
  exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api node backend/api/dist/demoAccounts.js "$@"
fi
exec npx tsx backend/api/src/demoAccounts.ts "$@"
