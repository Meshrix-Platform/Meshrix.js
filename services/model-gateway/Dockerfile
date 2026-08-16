FROM node:24.16.0-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Meshrix-Platform/Meshrix.js" \
      org.opencontainers.image.licenses="MIT"

RUN groupadd --gid 10001 modelgw \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin modelgw \
    && mkdir -p /app /var/lib/model-gateway \
    && chown -R modelgw:modelgw /app /var/lib/model-gateway

WORKDIR /app
COPY --chown=modelgw:modelgw package.json ./
COPY --chown=modelgw:modelgw src ./src
COPY --chown=modelgw:modelgw internal ./internal

ENV HOST=0.0.0.0 \
    PORT=8080 \
    MODEL_GATEWAY_DATA_ROOT=/var/lib/model-gateway \
    MAX_REQUEST_BYTES=2097152

USER 10001:10001
EXPOSE 8080
VOLUME ["/var/lib/model-gateway"]
ENTRYPOINT ["node", "src/main.mjs"]
