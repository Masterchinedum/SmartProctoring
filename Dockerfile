# syntax=docker/dockerfile:1.7
# ---------- build ----------
FROM node:24-bookworm-slim AS build
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
 && pnpm --filter @sp/server deploy --prod --legacy /out \
 && rm -rf /out/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/darwin \
           /out/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*/win32

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/web \
    MODELS_DIR=/app/server/models \
    STORAGE_DIR=/data/evidence \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app/server
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/server/models ./models
COPY --from=build /app/apps/web/dist /app/web
RUN mkdir -p /data/evidence && chown -R node:node /data /app
USER node
# 8080: the server (default command). 8090: the dedicated vision worker, when the container runs
# `node dist/vision-server.js` instead (docker-compose.vision.yml; docs/OPERATIONS.md §2). Never publish 8090.
EXPOSE 8080 8090
VOLUME ["/data/evidence"]
# Readiness of the process this container runs, told apart by PID 1's command line (also under `docker run --init`):
# the vision worker's /health/ready on VISION_WORKER_PORT (default 8090) for `node dist/vision-server.js`, else the
# server's /api/health on PORT.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "let w=false;try{w=require('fs').readFileSync('/proc/1/cmdline','utf8').includes('vision-server')}catch{}fetch('http://127.0.0.1:'+(w?(process.env.VISION_WORKER_PORT||8090)+'/health/ready':(process.env.PORT||8080)+'/api/health')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
