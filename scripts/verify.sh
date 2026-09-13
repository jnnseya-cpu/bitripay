#!/usr/bin/env bash
# Full verification of the three layers from a clean checkout: shared packages, backend, frontends.
# Usage: npm run verify            (add SKIP_MOBILE=1 to skip the Expo apps, which need their own node_modules)
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

step "lint (backend, frontend, shared)"
npm run lint

step "shared: build"
npm run build:shared
step "shared: tests (core, bitriqr, sdk-node)"
npm run test:shared

step "backend: typecheck + build"
npm run typecheck -w @bitripay/api
npm run build -w @bitripay/api
step "backend: tests"
npm run test -w @bitripay/api

step "frontend: typecheck + build (web, admin)"
npm run typecheck -w @bitripay/web
npm run build -w @bitripay/web
npm run typecheck -w @bitripay/admin
npm run build -w @bitripay/admin

if [ "${SKIP_MOBILE:-0}" != "1" ]; then
  step "frontend: mobile + payout device (typecheck, protocol tests)"
  if [ -d frontend/mobile/node_modules ]; then (cd frontend/mobile && npm run typecheck); else echo "frontend/mobile: run 'npm install' there first (skipped)"; fi
  if [ -d frontend/payout-device/node_modules ]; then (cd frontend/payout-device && npm run typecheck && npm test); else echo "frontend/payout-device: run 'npm install' there first (skipped)"; fi
fi

step "all green"
