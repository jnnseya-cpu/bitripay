# Backend: API + BitriPay Lite + USSD/SMS channels. Built from the repository root: docker build -f backend/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/core/package.json shared/core/
COPY shared/bitriqr/package.json shared/bitriqr/
COPY shared/charts/package.json shared/charts/
COPY shared/sdk-node/package.json shared/sdk-node/
COPY shared/sdk-js/package.json shared/sdk-js/
COPY backend/api/package.json backend/api/
COPY frontend/web/package.json frontend/web/
COPY frontend/admin/package.json frontend/admin/
RUN npm install --workspaces --include-workspace-root
COPY shared/core shared/core
COPY shared/bitriqr shared/bitriqr
COPY shared/charts shared/charts
COPY shared/sdk-node shared/sdk-node
COPY shared/sdk-js shared/sdk-js
COPY backend/api backend/api
RUN npm run build:shared && npm run build -w @bitripay/api
# Workspace-local modules (a dependency npm could not hoist) live next to the package; make the directories exist so
# the runtime stage can copy them unconditionally.
RUN mkdir -p backend/api/node_modules shared/core/node_modules shared/bitriqr/node_modules shared/charts/node_modules

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/core shared/core
COPY --from=build /app/shared/bitriqr shared/bitriqr
COPY --from=build /app/shared/charts shared/charts
COPY --from=build /app/backend/api/node_modules backend/api/node_modules
COPY --from=build /app/backend/api/dist backend/api/dist
COPY --from=build /app/backend/api/public backend/api/public
COPY --from=build /app/backend/api/package.json backend/api/package.json
RUN mkdir -p /data
EXPOSE 4000
CMD ["node", "backend/api/dist/index.js"]
