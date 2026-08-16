---
name: meshrix-js-developer-handbook
description: Meshrix.js developer handbook. Use when changing the product, release definition, packaging, published address contract, acceptance, or repository source. Do not use this package to operate a running instance or to connect external services.
---

# Meshrix.js Developer Handbook

This package is the **developer handbook**. It owns how Meshrix.js is built,
packaged, and addressed. The **user handbook** is `$meshrix-js-user-handbook`.
Do not mix those purposes in one closure.

`$meshrix-js` is the product identity and specialist-module library. It is not
a second mixed handbook. Apply `$meshrix-js-repository` before editing the
product repository.

## When to use this package

- Change server, console, gateway, permission, storage, or acceptance source
- Change `tools/registry/release-definition.registry.json` or its schema
- Change the published image target, platforms, or listen-address contract
- Pack or verify a `runtime-ui` release or offline bundle
- Write developer-facing evidence, verifiers, or release workflow

Do not use this package to start a published instance, log into the Console,
or bridge an external service. That work belongs to `$meshrix-js-user-handbook`.

## Published artifact

The release definition is the sole source for version, tag, channel, package
manifests, container target, and platforms. The schema locks
`container.target` to `runtime-ui` and platforms to `linux/amd64` plus
`linux/arm64`.

The published image and offline bundle are one process that serves Server and
Web Console. API-only `runtime` is a source-checkout verification image, not
the published artifact. Source `docker-compose.yml` may default to that
API-only image; it is not the release or offline artifact.

## Public address contract

A published, offline, or `--with-ui` artifact exposes **one public origin**.
Do not package a second public backend port.

| Surface | Address |
| --- | --- |
| Public origin | `<server-url>` |
| Web Console | `<server-url>/` |
| Server API | `<server-url>/api/` |
| Health | `<server-url>/api/healthz` |
| Downstream MCP and other governed clients | the same `<server-url>` |

The default listen port is `7228`. Host publish, bootstrap, advertised, and
active service URLs must name that same origin. Changing the host port changes
`<server-url>`; it does not split console and API onto two public ports.

Source development may start a separate Vite console for hot reload. That
second port is a development aid only. It is not part of the published
address contract and must not appear in release images, offline bundles, or
user-handbook integration instructions.

## Developer workflow

1. Preserve unrelated work. Identify one independently acceptable closure.
2. Update the canonical source first, then every owned consumer, derived
   fact, test, and document in the same change.
3. Keep the published address contract in `$meshrix-js-release-artifact-contract`.
4. Run the narrowest owning verifier, then the repository-owned release
   definition check when the artifact or address contract changed.
5. Treat commit and push as separate publication decisions.

Specialist development modules stay under `$meshrix-js`. Load only the module
that owns the current change: repository, core-platform-operations,
release-artifact-contract, release-engineering-workflow,
platform-acceptance-workflow, security, protocol, or the matching domain
module.

## Remaining host qualification

A Linux VM may close offline delivery and the current plan receipt. Prefer
Ubuntu; accept Debian. Native Linux qualification remains remaining required
work after the named Real-Machine Verification Workflow. Project-level
functional acceptance remains `npm run verify:acceptance`.
