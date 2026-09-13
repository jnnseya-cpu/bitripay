# Frontend (web): static build served by nginx. Built from the repository root: docker build -f frontend/web/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/core/package.json shared/core/
COPY shared/bitriqr/package.json shared/bitriqr/
COPY shared/sdk-node/package.json shared/sdk-node/
COPY backend/api/package.json backend/api/
COPY frontend/web/package.json frontend/web/
COPY frontend/admin/package.json frontend/admin/
RUN npm install --workspaces --include-workspace-root
COPY shared/core shared/core
COPY shared/bitriqr shared/bitriqr
COPY shared/sdk-node shared/sdk-node
COPY frontend/web frontend/web
RUN npm run build:shared && npm run build -w @bitripay/web

FROM nginx:alpine
COPY frontend/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/web/dist /usr/share/nginx/html
EXPOSE 80
