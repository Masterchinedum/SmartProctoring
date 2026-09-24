# syntax=docker/dockerfile:1.7
# ---------- build ----------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/detection/package.json packages/detection/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @sp/web build \
 && pnpm --filter @sp/server build \
 && pnpm --filter @sp/server deploy --prod --legacy /out

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/web \
    MODELS_DIR=/app/server/models \
    STORAGE_DIR=/data/evidence
WORKDIR /app/server
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/server/models ./models
COPY --from=build /app/apps/web/dist /app/web
RUN mkdir -p /data/evidence && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data/evidence"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
