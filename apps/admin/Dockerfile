FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm install --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN npm run build -w @bitripay/shared && npm run build -w @bitripay/admin

FROM nginx:alpine
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
