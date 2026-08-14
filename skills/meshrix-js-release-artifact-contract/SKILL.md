---
name: meshrix-js-release-artifact-contract
description: Developer-handbook chapter for the Meshrix.js published artifact shape and public address contract. Use from $meshrix-js-developer-handbook for release-definition, container-target, offline-packaging, or listen-address work. Do not operate a running instance from this chapter.
---

# Meshrix.js Release Artifact Contract

This chapter belongs to `$meshrix-js-developer-handbook`. It owns the
published artifact shape and the public address contract. Operating a running
instance belongs to `$meshrix-js-user-handbook`. Delivery workflow belongs to
`$meshrix-js-release-engineering-workflow`.

Apply `$meshrix-js-repository` first. Do not copy command maps into this skill.
Operator commands live in `docs/RUNBOOK.md` and `workflows/catalog.json`.

## Authority

`tools/registry/release-definition.registry.json` is the sole source for the
product version, tag, channel, package manifest set, container target, and
platforms. `tools/registry/schema/release-definition.schema.json` locks those
fields. Verify with the repository-owned release-definition command.

The published container target is `runtime-ui`. Platforms are `linux/amd64`
and `linux/arm64`. API-only `runtime` is a source-checkout verification image,
not the published artifact. Offline delivery and the enterprise single-node
bundle must use `runtime-ui` with the server serving the Web Console.

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
external integration instructions.

## Packaging invariants

- The release image and offline bundle serve Server and Web Console from one
  process.
- Provenance and pack receipts must record `runtime-ui`. Contract-fixture
  bytes do not satisfy a real pack.
- Source `docker-compose.yml` may default to API-only `runtime` for local
  deployment verification. That file is not the offline or published artifact.
- Do not document or implement a second published listen address for “backend
  bridging.” External services connect through the one origin; see
  `$meshrix-js-user-handbook`.

## Verify

Confirm the release definition still locks `container.target` to `runtime-ui`
and both Linux platforms. Confirm pack or image evidence names `runtime-ui`
and a single origin. Do not treat a Vite console port as published surface.
