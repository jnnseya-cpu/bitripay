#!/usr/bin/env bash
# Build every layer for production and pack a release bundle (release/bitripay-<version>-<sha>.tar.gz) containing the
# compiled backend, the static web and admin builds, the shared packages and the deploy folder — for hosts that deploy
# from an archive instead of git. Usage: npm run release
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD)
OUT=release/bitripay-$VERSION-$SHA
rm -rf "$OUT" && mkdir -p "$OUT"
npm run build:shared
npm run build -w @bitripay/api
npm run build -w @bitripay/web
npm run build -w @bitripay/admin
mkdir -p "$OUT/backend/api" "$OUT/frontend/web" "$OUT/frontend/admin" "$OUT/shared"
cp -r backend/api/dist backend/api/package.json backend/api/public backend/api/Dockerfile backend/api/.env.example "$OUT/backend/api/"
cp -r frontend/web/dist frontend/web/nginx.conf frontend/web/Dockerfile "$OUT/frontend/web/"
cp -r frontend/admin/dist frontend/admin/nginx.conf frontend/admin/Dockerfile "$OUT/frontend/admin/"
for p in core bitriqr sdk-node sdk-js; do mkdir -p "$OUT/shared/$p"; cp -r "shared/$p/dist" "shared/$p/package.json" "$OUT/shared/$p/"; done
cp -r deploy scripts/deploy.sh package.json package-lock.json "$OUT/"
git log -1 --format='%H %s' > "$OUT/RELEASE"
tar -C release -czf "$OUT.tar.gz" "$(basename "$OUT")"
echo "release bundle: $OUT.tar.gz ($(du -h "$OUT.tar.gz" | cut -f1))"
