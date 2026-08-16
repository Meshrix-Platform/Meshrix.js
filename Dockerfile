# Meshrix.js server container.
# Deployment preset index: packages/foundation/config/deployment/index.json
ARG NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${NODE_BASE_IMAGE} AS deps

ARG ROOTFS=/
WORKDIR app

COPY package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts LICENSE ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/capabilities/package.json ./packages/capabilities/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/foundation/package.json ./packages/foundation/package.json
COPY packages/protocols/package.json ./packages/protocols/package.json
COPY packages/server-runtime/package.json ./packages/server-runtime/package.json
COPY packages/ui-console/package.json ./packages/ui-console/package.json
COPY vendor ./vendor

RUN rm -f "${ROOTFS}etc/apt/apt.conf.d/docker-clean"

RUN --mount=type=cache,target=${ROOTFS}var/cache/apt,sharing=locked \
    --mount=type=cache,target=${ROOTFS}var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++

ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,id=meshrix-core-npm,target=${ROOTFS}var/cache/meshrix/npm,sharing=locked \
    npm config set registry "${NPM_REGISTRY}" \
    && npm_config_build_from_source=true npm_config_nodedir="${ROOTFS}usr/local" npm ci --foreground-scripts --loglevel=info \
      --cache="${ROOTFS}var/cache/meshrix/npm" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=300000 \
      --fetch-timeout=600000

FROM deps AS npm-package-verifier

RUN --mount=type=cache,id=meshrix-core-npm,target=${ROOTFS}var/cache/meshrix/npm,sharing=locked \
    test -d "${ROOTFS}var/cache/meshrix/npm/_cacache" \
    && mkdir -p "${ROOTFS}opt/meshrix-npm-cache" \
    && cp -a "${ROOTFS}var/cache/meshrix/npm/_cacache" "${ROOTFS}opt/meshrix-npm-cache/_cacache" \
    && chmod -R a+rX "${ROOTFS}opt/meshrix-npm-cache"

FROM deps AS build

COPY apps/server ./apps/server
COPY apps/console ./apps/console
COPY packages ./packages
COPY content ./content
COPY tools ./tools
COPY docs ./docs

RUN npm run build:node
RUN npm prune --omit=dev

FROM deps AS build-ui

COPY apps/server ./apps/server
COPY apps/console ./apps/console
COPY packages ./packages
COPY content ./content
COPY tools ./tools
COPY docs ./docs

RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_BASE_IMAGE} AS runtime

ARG ROOTFS=/
ARG MESHRIX_SOURCE_REPOSITORY
ARG MESHRIX_SOURCE_REF
ARG MESHRIX_SOURCE_COMMIT

LABEL org.opencontainers.image.source="https://github.com/${MESHRIX_SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${MESHRIX_SOURCE_COMMIT}" \
      org.opencontainers.image.ref.name="${MESHRIX_SOURCE_REF}"

ENV NODE_ENV=production \
    MESHRIX_SERVER_PORT=7228 \
    CODEX_HOME=../codex-home \
    PATH=./node_modules/.bin:$PATH

RUN groupadd --system --gid 10001 meshrix \
    && useradd --system --uid 10001 --gid meshrix --home-dir "${ROOTFS}home/meshrix" --create-home --shell "${ROOTFS}usr/sbin/nologin" meshrix

WORKDIR app

COPY --chown=meshrix:meshrix --from=build app/package.json app/package-lock.json ./
COPY --chown=meshrix:meshrix --from=build app/LICENSE ./LICENSE
COPY --chown=meshrix:meshrix --from=build app/node_modules ./node_modules
COPY --chown=meshrix:meshrix --from=build app/dist ./dist
COPY --chown=meshrix:meshrix --from=build app/apps/server ./apps/server
COPY --chown=meshrix:meshrix --from=build app/apps/console/package.json ./apps/console/package.json
COPY --chown=meshrix:meshrix --from=build app/packages ./packages
COPY --chown=meshrix:meshrix --from=build app/content ./content
COPY --chown=meshrix:meshrix --from=build app/tools ./tools
COPY --chown=meshrix:meshrix --from=build app/docs ./docs

RUN mkdir -p data backups ../codex-home \
    && chown -R meshrix:meshrix data backups ../codex-home

USER meshrix

EXPOSE 7228

VOLUME ["/app/data", "/app/backups", "/codex-home"]

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7228/api/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/tools/server-scripts/start-server.js", "--host", "0.0.0.0", "--port", "7228", "--data-dir", "data", "--allow-public-console"]

FROM runtime AS runtime-ui

USER root

COPY --chown=meshrix:meshrix --from=build-ui app/build/dist ./build/dist

RUN test -f ./build/dist/index.html

USER meshrix

CMD ["node", "dist/tools/server-scripts/start-server.js", "--with-ui", "--host", "0.0.0.0", "--port", "7228", "--data-dir", "data", "--allow-public-console"]

FROM runtime AS final
