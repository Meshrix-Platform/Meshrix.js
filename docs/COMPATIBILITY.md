# Meshrix.js Compatibility

This document records current compatibility targets and the evidence required
for a support claim. [Status](STATUS.md) owns the product-wide intent,
implementation, verification, release, and support result.

This matrix is informational. It does not block the current production-use
closure, deployment to the existing virtual machine, or iteration from real
usage. Only a concrete defect in an actively used path enters current work.

## Evidence and remaining-work rules

- A source path or configured target is an implementation fact. Support remains
  remaining required work until the named qualification evidence exists.
- A passing focused check is verification for its exact scope. Release
  completeness remains remaining required work until the Functional Release
  Gate accepts the immutable candidate.
- A Functional Release Gate receipt applies only to its immutable candidate.
- Functional candidate acceptance, including Linux amd64 and arm64 offline
  artifacts delivered onto a Linux virtual machine reachable from a macOS
  operator host, closes the current offline and plan receipts. A Linux OS
  inside the VM is enough for those closures. Ubuntu is preferred; Debian is
  accepted. Native Linux, Ubuntu, Debian, cloud, macOS, Windows, connector,
  cross-host, and recovery-environment qualification remain remaining required
  work after the named Real-Machine Verification Workflow.
- A source tag, npm package, container manifest, GitHub Release, and hosted
  deployment are separate remaining release or operation workstreams.
- Environment qualification requires the same accepted candidate to pass the
  named Real-Machine Verification Workflow for the exact system, architecture,
  artifact, configuration, and deployment profile.
- Client, plugin, and optional-service adoption evidence is independently
  owned remaining work and cannot block or promote Meshrix.js acceptance.

## Runtime and delivery matrix

| Surface | Current target | Current status |
| --- | --- | --- |
| Enterprise single-node profile | `enterprise-single-node` private-deployment release profile | Pre-release target; release publication and environment qualification remain remaining required work. |
| Node.js runtime | Version range declared by `package.json` | Implemented target; operating-system qualification remains remaining required work on the named host workflow. |
| Local source startup | Repository npm scripts and local server entry point | Development path; release and production qualification remain remaining required work. |
| Server and Web Console container | Linux amd64 and arm64 OCI artifacts on a Linux VM | Assembly and functional-verification target; Ubuntu preferred, Debian accepted; native Linux or distribution qualification remains remaining required work until its exact workflow passes. |
| Plugin Console iframe | Opaque-origin sandbox and versioned capability bridge | Implemented through an opaque `srcdoc` iframe without `allow-same-origin`, with a bounded and revocable Host bridge. |
| npm release set | Manifests named by the release definition | Publication target; package publication remains remaining required work for the immutable accepted candidate. |
| MCP connector | Repository-owned generic connector and security boundary | Functional target; each packaged operating-system artifact still requires its own publication and environment receipt. |
| Storage | Self-contained local storage by default; optional integrations only when explicitly configured | Local implementation target; each optional datastore remains remaining qualification work. |
| Production ingress | Administrator-owned TLS boundary conforming to the documented trusted-proxy contract | Functional target; each deployed proxy environment remains remaining qualification work. |
| Backup and restore | Independent backup root and clean-root recovery journey | Required candidate closure; recovery-environment qualification remains remaining required work. |
| Upgrade and rollback | N-1 preflight, backup, migration, health admission, and failure rollback | Required candidate closure; upgrade-environment qualification remains remaining required work. |

## Protocol and integration ownership

| Surface | Owner and boundary | Current status |
| --- | --- | --- |
| HTTP, MCP, plugin-package, pubsub, storage, checkpoint, and console protocols | Meshrix.js protocol and technical documents | Implemented scope is defined only by the owning documents and schemas. |
| Plugin browser code | Opaque-origin iframe with a bounded Host bridge | Implemented. Verified plugin source is fetched by the Host and executed only inside the opaque iframe; the iframe receives no same-origin privilege or direct network access. |
| Upstream service publishing | Meshrix.js server gateway and Operation Permission | Server-side functional target; compatible external-service adoption is independently owned. |
| Downstream client protocol | Meshrix.js generic protocol, authorization, credential, cache, proxy, and lifecycle boundary | Neutral-peer verification target; no client product is a Meshrix.js release dependency. |
| Client-specific adapters | Operator-supplied external client-adapter packages selected explicitly | Meshrix.js validates the package contract and never discovers implementations from another source repository. |
| Optional parsers, providers, datastores, and service adapters | Repository-local `services/` or `plugins/` implementation when present | Disabled or absent by default; each enabled path needs its own contract and evidence. |
| Pactium | Exact file-vendored dependency `pactium@0.8.0` (`file:vendor/pactium-0.8.0.tgz`) and protocol identities declared by Meshrix.js manifests and version registry | Dependency compatibility is limited to the exact declared identities. Meshrix.js release and environment qualification remain remaining required work on their own receipts. |

## Pactium host-helper deprecation

Meshrix.js consumes host-neutral Pactium helpers as the authoritative implementation. The following Meshrix.js-local exports remain callable only as Deprecated delegates until Meshrix.js 1.0.0 removes them:

| Deprecated Meshrix.js export | Replacement | Removal |
| --- | --- | --- |
| `toPactiumCanonicalSafeValue` | `toCanonicalSafeValue` from `pactium` | Meshrix.js 1.0.0 |
| `classifyProtocolSubstrateStorageArtifact` | `classifyProtocolStorageArtifact` from `pactium` | Meshrix.js 1.0.0 |
| `inspectPactiumFreshDataDir` | `inspectDataDir` from `pactium` | Meshrix.js 1.0.0 |
| `assertPactiumFreshDataDir` | `assertCurrentDataDir` from `pactium` | Meshrix.js 1.0.0 |
| `PACTIUM_MANIFEST_FILE` / `PACTIUM_SQLITE_FILE` / `PROTOCOL_SUBSTRATE_STORAGE_CATEGORY` | Same names from `pactium` (`PROTOCOL_STORAGE_CATEGORY`) | Meshrix.js 1.0.0 |

Iteration workflow: Pactium publishes first; Meshrix.js switches and Deprecated-wraps second; Meshrix.js next major removes the wrappers. Host product semantics (aspect, checkpoint tree, LSM, backup) remain Meshrix.js-owned.

### Meshrix.js 1.0.0 removal checklist (phase B; not this release)

When Meshrix.js 1.0.0 is cut, delete the Deprecated wrappers and retarget callers—no compatibility layer and no redirect tests:

1. Remove `packages/foundation/src/checkpoint/tree/pactium-canonical-safe.ts` and every import of `toPactiumCanonicalSafeValue`; call `toCanonicalSafeValue` from `pactium` instead.
2. In `packages/foundation/src/checkpoint/tree/pactium-substrate-preflight.ts`, remove Deprecated re-exports (`PACTIUM_MANIFEST_FILE`, `PACTIUM_SQLITE_FILE`, `PROTOCOL_SUBSTRATE_STORAGE_CATEGORY`, `classifyProtocolSubstrateStorageArtifact`, `inspectPactiumFreshDataDir`, `assertPactiumFreshDataDir`) and update Meshrix.js callers to the Pactium symbols above. Keep Meshrix.js-owned helpers (`resolveMeshrixPactiumDataDir`, `createMeshrixPactiumRuntime`, lease/config wiring).
3. Delete Deprecated smoke/delegate tests that exist only to cover the old Meshrix.js export names; keep coverage on the Pactium path and Meshrix.js host surfaces.
4. Drop this section and the Unreleased CHANGELOG deprecation note once the symbols are gone; `COMPATIBILITY.md` then describes only the current `pactium` dependency path.

## MCP client targets

Meshrix.js verifies only its neutral connector boundary. The documented
downstream adapter target scope is OpenClaw, Codex, Claude Code, Antigravity,
OpenCode, Pi, and Kimi CLI. A named client becomes qualified only when the
operator supplies an exact adapter artifact with a named client version and
configuration plus current lifecycle evidence. Those client qualifications
remain remaining required work until that evidence exists.
