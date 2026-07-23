# LicoMesh server container.
# Deployment preset index: packages/foundation/config/deployment/index.json
ARG NODE_BASE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${NODE_BASE_IMAGE} AS deps

ARG ROOTFS=/
WORKDIR app

COPY package.json package-lock.json tsconfig.json vite.config.ts LICENSE ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/capabilities/package.json ./packages/capabilities/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/foundation/package.json ./packages/foundation/package.json
COPY packages/protocols/package.json ./packages/protocols/package.json
COPY packages/server-runtime/package.json ./packages/server-runtime/package.json
COPY packages/ui-console/package.json ./packages/ui-console/package.json

RUN rm -f "${ROOTFS}etc/apt/apt.conf.d/docker-clean"

RUN --mount=type=cache,target=${ROOTFS}var/cache/apt,sharing=locked \
    --mount=type=cache,target=${ROOTFS}var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++

ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN --mount=type=cache,id=licomesh-core-npm,target=${ROOTFS}var/cache/licomesh/npm,sharing=locked \
    npm config set registry "${NPM_REGISTRY}" \
    && npm_config_build_from_source=true npm_config_nodedir="${ROOTFS}usr/local" npm ci --foreground-scripts --loglevel=info \
      --cache="${ROOTFS}var/cache/licomesh/npm" \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=300000 \
      --fetch-timeout=600000

FROM deps AS npm-package-verifier

RUN --mount=type=cache,id=licomesh-core-npm,target=${ROOTFS}var/cache/licomesh/npm,sharing=locked \
    test -d "${ROOTFS}var/cache/licomesh/npm/_cacache" \
    && mkdir -p "${ROOTFS}opt/lico-npm-cache" \
    && cp -a "${ROOTFS}var/cache/licomesh/npm/_cacache" "${ROOTFS}opt/lico-npm-cache/_cacache" \
    && chmod -R a+rX "${ROOTFS}opt/lico-npm-cache"

FROM deps AS build

COPY apps/server ./apps/server
COPY packages ./packages
COPY content ./content
COPY tools ./tools
COPY docs ./docs

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
ARG LICO_SOURCE_REPOSITORY
ARG LICO_SOURCE_REF
ARG LICO_SOURCE_COMMIT

LABEL org.opencontainers.image.source="https://github.com/${LICO_SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${LICO_SOURCE_COMMIT}" \
      org.opencontainers.image.ref.name="${LICO_SOURCE_REF}"

ENV NODE_ENV=production \
    LICO_SERVER_PORT=7228 \
    CODEX_HOME=../codex-home \
    PATH=./node_modules/.bin:$PATH

RUN groupadd --system --gid 10001 lico \
    && useradd --system --uid 10001 --gid lico --home-dir "${ROOTFS}home/lico" --create-home --shell "${ROOTFS}usr/sbin/nologin" lico

WORKDIR app

COPY --chown=lico:lico --from=build app/package.json app/package-lock.json ./
COPY --chown=lico:lico --from=build app/LICENSE ./LICENSE
COPY --chown=lico:lico --from=build app/node_modules ./node_modules
COPY --chown=lico:lico --from=build app/apps/server ./apps/server
COPY --chown=lico:lico --from=build app/apps/console/package.json ./apps/console/package.json
COPY --chown=lico:lico --from=build app/packages ./packages
COPY --chown=lico:lico --from=build app/content ./content
COPY --chown=lico:lico --from=build app/tools ./tools
COPY --chown=lico:lico --from=build app/docs ./docs

RUN mkdir -p data ../codex-home \
    && chown -R lico:lico data ../codex-home

USER lico

EXPOSE 7228

VOLUME ["/app/data"]

CMD ["node", "tools/server-scripts/start-server.mjs", "--host", "0.0.0.0", "--port", "7228", "--data-dir", "data", "--allow-public-console"]

FROM runtime AS runtime-ui

USER root

COPY --chown=lico:lico --from=build-ui app/build/dist ./build/dist

RUN test -f ./build/dist/index.html

USER lico

CMD ["node", "tools/server-scripts/start-server.mjs", "--with-ui", "--host", "0.0.0.0", "--port", "7228", "--data-dir", "data", "--allow-public-console"]

FROM runtime AS final
