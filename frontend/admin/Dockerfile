# Frontend (admin): static build served by nginx. Built from the repository root: docker build -f frontend/admin/Dockerfile .
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
COPY frontend/admin frontend/admin
RUN npm run build:shared && npm run build -w @bitripay/admin

FROM nginx:alpine
COPY frontend/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/admin/dist /usr/share/nginx/html
EXPOSE 80
