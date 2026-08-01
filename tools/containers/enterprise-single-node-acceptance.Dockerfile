FROM node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7 AS node-runtime

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

COPY --from=node-runtime /usr/local/ /usr/local/

ENV CI=1

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*

COPY . /opt/meshrix-dependency-source

WORKDIR /opt/meshrix-dependency-source

RUN npm ci

RUN mkdir -p /workspace /worker /evidence \
    && chmod 0700 /worker \
    && chmod 0700 /evidence

WORKDIR /workspace
