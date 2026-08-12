FROM node:24.16.0-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Meshrix-Platform/Meshrix.js" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN groupadd --gid 10001 skillhub \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin skillhub \
    && mkdir -p /app /var/lib/skill-hub \
    && chown -R skillhub:skillhub /app /var/lib/skill-hub

WORKDIR /app
COPY --chown=skillhub:skillhub package.json ./
COPY --chown=skillhub:skillhub src ./src
COPY --chown=skillhub:skillhub internal ./internal
COPY --chown=skillhub:skillhub state-machines ./state-machines

ENV PORT=8080 \
    SKILL_HUB_DATA_ROOT=/var/lib/skill-hub \
    MAX_REQUEST_BYTES=2097152

USER 10001:10001
EXPOSE 8080
VOLUME ["/var/lib/skill-hub"]
ENTRYPOINT ["node", "src/main.mjs"]
