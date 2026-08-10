# Meshrix.js Compatibility

This document records current compatibility targets and the evidence required
for a support claim. [Status](STATUS.md) owns the product-wide intent,
implementation, verification, release, and support result.

## Claim rules

- A source path or configured target is an implementation fact, not support.
- A passing focused check is verification for its exact scope, not a release.
- A Functional Release Gate receipt applies only to its immutable candidate.
- Functional candidate acceptance, including Linux amd64 and arm64 offline
  artifacts, does not automatically establish Linux real-machine, cloud,
  macOS, Windows, connector, cross-host, or recovery-environment support.
- A source tag, npm package, container manifest, GitHub Release, and hosted
  deployment are separate release or operation facts.
- Environment support requires the same accepted candidate to pass the named
  Real-Machine Verification Workflow for the exact system, architecture,
  artifact, configuration, and deployment profile.
- Client, plugin, and optional-service adoption evidence is independently
  owned and cannot block or promote Meshrix.js acceptance.

## Runtime and delivery matrix

| Surface | Current target | Current claim |
| --- | --- | --- |
| Enterprise single-node profile | `enterprise-single-node` private-deployment release profile | Pre-release target; release publication and environment support are currently unclaimed. |
| Node.js runtime | Version range declared by `package.json` | Implemented target; no operating-system support claim is asserted here. |
| Local source startup | Repository npm scripts and local server entry point | Development path; not a release or production-support claim. |
| Server and Web Console container | Linux amd64 and arm64 OCI artifacts | Assembly and functional-verification target; native environment support remains unclaimed until its exact workflow passes. |
| Plugin Console iframe | Opaque-origin sandbox and versioned capability bridge | Target contract only. Current verified Console code still executes as trusted same-origin code; third-party browser isolation is unclaimed until migration and browser escape verification pass. |
| npm release set | Manifests named by the release definition | Publication target only; package publication must be proved independently for the immutable accepted candidate. |
| MCP connector | Repository-owned generic connector and security boundary | Functional target; each packaged operating-system artifact requires its own publication and environment receipt. |
| Storage | Self-contained local storage by default; optional integrations only when explicitly configured | Local implementation target; an optional datastore has a separate compatibility claim. |
| Production ingress | Administrator-owned TLS boundary conforming to the documented trusted-proxy contract | Functional target; one deployed proxy environment requires its own evidence. |
| Backup and restore | Independent backup root and clean-root recovery journey | Required candidate closure; no recovery support claim is currently asserted. |
| Upgrade and rollback | N-1 preflight, backup, migration, health admission, and failure rollback | Required candidate closure; no upgrade support claim is currently asserted. |

## Protocol and integration ownership

| Surface | Owner and boundary | Current claim |
| --- | --- | --- |
| HTTP, MCP, plugin-package, pubsub, storage, checkpoint, and console protocols | Meshrix.js protocol and technical documents | Implemented scope is defined only by the owning documents and schemas. |
| Plugin browser code | Planned opaque-origin iframe with a bounded Host bridge | Current same-origin loading is trusted deployment code, not a hostile-code sandbox or compatibility guarantee for legacy plugin entries. |
| Upstream service publishing | Meshrix.js server gateway and Operation Permission | Server-side functional target; compatible external-service adoption is independently owned. |
| Downstream client protocol | Meshrix.js generic protocol, authorization, credential, cache, proxy, and lifecycle boundary | Neutral-peer verification target; no client product is a Meshrix.js release dependency. |
| Client-specific adapters | Repository-local packages selected explicitly by an operator | Meshrix.js validates the package contract and never discovers implementations from another source repository. |
| Optional parsers, providers, datastores, and service adapters | Repository-local `services/` or `plugins/` implementation when present | Disabled or absent by default; each enabled path needs its own contract and evidence. |
| Pactium | Exact dependency `pactium@0.7.0` and protocol identities declared by Meshrix.js manifests and version registry | Dependency compatibility is limited to the exact declared identities; it does not establish Meshrix.js release or environment support. |

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

Meshrix.js verifies only its neutral connector boundary. A client becomes
supported only when the operator supplies an exact adapter artifact with a
named client version and configuration plus current lifecycle evidence. This
repository does not currently make those client support claims.
