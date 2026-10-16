# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/collaboration-api/package.json apps/collaboration-api/
COPY apps/desktop-distribution/package.json apps/desktop-distribution/
COPY packages/asset-domain/package.json packages/asset-domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/studio-plugin/package.json packages/studio-plugin/
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/apps/collaboration-api
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/collaboration-api/node_modules /app/apps/collaboration-api/node_modules
COPY --from=deps /app/packages/asset-domain/node_modules /app/packages/asset-domain/node_modules
COPY --from=deps /app/packages/contracts/node_modules /app/packages/contracts/node_modules
COPY --from=deps /app/packages/studio-plugin/node_modules /app/packages/studio-plugin/node_modules
COPY packages/asset-domain /app/packages/asset-domain
COPY packages/contracts /app/packages/contracts
COPY tsconfig.base.json /app/tsconfig.base.json
COPY pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY apps/collaboration-api /app/apps/collaboration-api
RUN chmod +x /app/apps/collaboration-api/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/apps/collaboration-api/docker-entrypoint.sh"]
