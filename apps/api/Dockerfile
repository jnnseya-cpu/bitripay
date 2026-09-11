FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm install --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @bitripay/shared && npm run build -w @bitripay/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
RUN mkdir -p /data
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
