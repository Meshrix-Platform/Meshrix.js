FROM golang:1.26.6-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go test ./...
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go vet ./...
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/format-convert ./cmd/format-convert

FROM debian:bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/Meshrix-Platform/Meshrix.js" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        fonts-dejavu-core \
        fonts-liberation2 \
        fonts-noto-cjk \
        libreoffice-writer \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /var/lib/format-convert --create-home format-convert \
    && install -d -o format-convert -g format-convert -m 0700 /tmp/format-convert

COPY --from=builder /out/format-convert /usr/local/bin/format-convert

ENV PORT=8080 \
    SOFFICE_BINARY=/usr/bin/soffice \
    TEMP_ROOT=/tmp

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/format-convert"]
