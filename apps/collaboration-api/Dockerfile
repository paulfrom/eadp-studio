# The multi-platform image digest fixes the runtime input.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base

FROM base AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/collaboration-api/package.json apps/collaboration-api/
COPY apps/desktop-distribution/package.json apps/desktop-distribution/
COPY packages/asset-domain/package.json packages/asset-domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/studio-plugin/package.json packages/studio-plugin/
RUN pnpm install --frozen-lockfile
COPY apps/collaboration-api apps/collaboration-api
COPY packages/asset-domain packages/asset-domain
COPY packages/contracts packages/contracts
RUN pnpm --filter @eadp/collaboration-api deploy --prod --legacy /out

FROM base
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app/apps/collaboration-api
COPY --chown=node:node --from=deps /out /app/apps/collaboration-api
COPY --chown=node:node packages/studio-plugin/assets/prototype-template.manifest.json /app/packages/studio-plugin/assets/prototype-template.manifest.json
RUN test "$(id -u node):$(id -g node)" = '1000:1000' \
    && chmod +x /app/apps/collaboration-api/docker-entrypoint.sh
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/apps/collaboration-api/docker-entrypoint.sh"]
