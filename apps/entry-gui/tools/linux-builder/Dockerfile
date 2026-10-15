ARG NODE_VERSION
ARG NPM_VERSION
ARG RUST_VERSION
ARG NODE_RUNTIME_ARTIFACT
ARG NODE_RUNTIME_ARCHIVE_SHA256

FROM rust:${RUST_VERSION}-bookworm-slim AS rust-toolchain

FROM ubuntu:22.04

ARG NODE_VERSION
ARG NPM_VERSION
ARG RUST_VERSION
ARG NODE_RUNTIME_ARTIFACT
ARG NODE_RUNTIME_ARCHIVE_SHA256

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/opt/node/bin:/usr/local/cargo/bin:${PATH} \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      libayatana-appindicator3-dev \
      libfuse2 \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      librsvg2-dev \
      patchelf \
      pkg-config \
      rpm \
      wget \
      xdg-utils \
      xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/node /tmp/node-runtime \
    && curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_RUNTIME_ARTIFACT}" \
      --output /tmp/node-runtime/node.tar.xz \
    && printf '%s  %s\n' "${NODE_RUNTIME_ARCHIVE_SHA256}" /tmp/node-runtime/node.tar.xz | sha256sum --check --status \
    && archive_root="${NODE_RUNTIME_ARTIFACT%.tar.xz}" \
    && tar -xJf /tmp/node-runtime/node.tar.xz -C /opt/node --strip-components=1 \
      "${archive_root}/bin" "${archive_root}/lib/node_modules/npm" \
    && rm -rf /tmp/node-runtime \
    && npm install --global "npm@${NPM_VERSION}" \
    && test "$(rustc --version | cut -d' ' -f2)" = "${RUST_VERSION}" \
    && test "$(npm --version)" = "${NPM_VERSION}"

WORKDIR /workspace

ENTRYPOINT ["node", "apps/entry-gui/tools/linux-container-entry.mjs"]
