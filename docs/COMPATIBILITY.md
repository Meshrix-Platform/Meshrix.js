# Compatibility

This document records the open platform compatibility target for private deployment.

| Area | Target |
| --- | --- |
| Runtime | Node.js server runtime using the version range in `package.json`. |
| Packaging | npm scripts, Dockerfile, and compose file shipped by this repository. |
| Storage | Local metadata and object storage by default. |
| Console | Vue console served from the repository build. |
| Protocols | HTTP, MCP, plugin-package, pubsub, storage, checkpoint, and console protocol surfaces. |
| Downstream adapters | Pinned external Meshrix-Plugins packages for local connector-managed clients; Core contains only the generic adapter protocol and security boundary. |
| Governance | Operation Permission, tag policy, approval, audit, metrics, and redaction. |

## Release Verification Levels

- **Published** means the target is assembled and verified by the canonical
  release workflow.
- **Current-host verified** means the release candidate was exercised on the
  current development environment: macOS arm64, Node.js 24.16.0, npm 11, with
  a Linux arm64 Docker runtime.
- **Not in this release** means source support may exist, but the target does
  not block publication and the release makes no runtime support claim for it.

| Surface | Target | Status |
| --- | --- | --- |
| Core Node.js runtime | macOS arm64 with Node.js 24 | Current-host verified. |
| npm release set | Seven public `@meshrix/*` workspaces, `meshrix-mcp-connector`, and `meshrix` | Canonical tag-workflow target; a required Node.js 22 clean install/start probe and credential-free all-package registry preflight complete before remote container mutation, and each package is later published or integrity-reverified. |
| Server and Web Console container | Linux amd64 and arm64 | Canonical signed multi-platform publication target; both platform images are scanned with pinned Trivy and bound to platform-specific SLSA provenance and SPDX evidence. |
| MCP Connector | macOS arm64 | Published target; the exact final archive, bundled Node runtime, launcher, installer delegation, and no-scan path execute on a required macOS arm64 tag-workflow runner. |
| MCP Connector | macOS x64, Linux x64/arm64, Windows x64/arm64 | Not in this release. |
| MCP client execution location | Local connector-managed process | Published target; OrbStack and remote-Linux direct HTTP registration are not in this release because they cannot attach the required process identity signature. Installation rejects them before device authorization. |
| Upstream service publishing | Developer control plane through gateway, Operation Permission, and the published downstream protocol boundary | Supported by the production-path server gate and required positive report. Compatible consumer adoption is a separate support fact and is never a Core dependency. |
| MeshrixUp | External desktop/mobile client implementing published protocols | Optional and independently released; its repository, implementation, build, plans, tests, reports, and receipts are not required for core startup, server implementation, or server release readiness. |
| Pactium | Package `0.5.0`; protocol `pactium.v0.2`; data schema `pactium.v0.2.schema.latest` | Exact core dependency; storage selection is delegated to Pactium `auto` when the user leaves it unconfigured, and owned persistent ports use the idempotent async close contract. |

## MCP Client Compatibility

Client availability, provider-account proof, configuration formats, and real
client lifecycle evidence belong to the independently released adapter packages
in Meshrix-Plugins. They do not block or promote a Core release. Core verifies
only the neutral adapter protocol, package integrity/cache behavior, credential
isolation, connector proxy, and lifecycle transaction.

Optional middleware integrations become compatibility targets through code, configuration, documentation, and verifier updates.

Supported connector-managed client targets in this release: OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI.
