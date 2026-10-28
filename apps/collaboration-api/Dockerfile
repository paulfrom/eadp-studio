# The multi-platform image digest and dated Debian repositories fix the runtime
# and compiler inputs used by the standalone prototype merge verifier.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
COPY apps/collaboration-api/git-verifier.sources /etc/apt/sources.list.d/studio-snapshot.sources
RUN apt-get update && apt-get install -y --no-install-recommends util-linux zlib1g && rm -rf /var/lib/apt/lists/*

FROM base AS git-verifier
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev make xz-utils zlib1g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY apps/collaboration-api/git-verifier.sha256 ./
RUN curl --fail --location --connect-timeout 20 --max-time 180 https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz -o git-2.56.0.tar.xz \
    && sha256sum --check git-verifier.sha256 \
    && tar -xf git-2.56.0.tar.xz
WORKDIR /build/git-2.56.0
RUN make -j2 prefix=/usr/local NO_CURL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_ICONV=1 NO_OPENSSL=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 git \
    && install -D -m 0755 git /out/bin/git \
    && install -D -m 0644 COPYING /out/licenses/git/COPYING

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
COPY --from=git-verifier /out/bin/git /usr/local/bin/git
COPY --from=git-verifier /out/licenses/git/COPYING /usr/local/share/licenses/git/COPYING
RUN test "$(id -u node):$(id -g node)" = '1000:1000' \
    && chmod +x /app/apps/collaboration-api/docker-entrypoint.sh \
    && mkdir -p /usr/local/share/git-core/templates
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/apps/collaboration-api/docker-entrypoint.sh"]
