# Meshrix Compatibility

This document records current compatibility targets and the evidence required
for a support claim. [Status](STATUS.md) owns the product-wide intent,
implementation, verification, release, and support result.

## Claim rules

- A source path or configured target is an implementation fact, not support.
- A passing focused check is verification for its exact scope, not a release.
- A Functional Release Gate receipt applies only to its immutable candidate.
- A source tag, npm package, container manifest, GitHub Release, and hosted
  deployment are separate release or operation facts.
- Environment support requires the same accepted candidate to pass the named
  Real-Machine Verification Workflow for the exact system, architecture,
  artifact, configuration, and deployment profile.
- Client, plugin, and optional-service adoption evidence is independently
  owned and cannot block or promote Meshrix acceptance.

## Runtime and delivery matrix

| Surface | Current target | Current claim |
| --- | --- | --- |
| Enterprise single-node profile | `enterprise-single-node` private-deployment release profile | Pre-release target; release publication and environment support are currently unclaimed. |
| Node.js runtime | Version range declared by `package.json` | Implemented target; no operating-system support claim is asserted here. |
| Local source startup | Repository npm scripts and local server entry point | Development path; not a release or production-support claim. |
| Server and Web Console container | Linux amd64 and arm64 OCI artifacts | Assembly and functional-verification target; native environment support remains unclaimed until its exact workflow passes. |
| npm release set | Manifests named by the release definition | Publication target only; package publication must be proved independently for the immutable accepted candidate. |
| MCP connector | Repository-owned generic connector and security boundary | Functional target; each packaged operating-system artifact requires its own publication and environment receipt. |
| Storage | Self-contained local storage by default; optional integrations only when explicitly configured | Local implementation target; an optional datastore has a separate compatibility claim. |
| Production ingress | Administrator-owned TLS boundary conforming to the documented trusted-proxy contract | Functional target; one deployed proxy environment requires its own evidence. |
| Backup and restore | Independent backup root and clean-root recovery journey | Required candidate closure; no recovery support claim is currently asserted. |
| Upgrade and rollback | N-1 preflight, backup, migration, health admission, and failure rollback | Required candidate closure; no upgrade support claim is currently asserted. |

## Protocol and integration ownership

| Surface | Owner and boundary | Current claim |
| --- | --- | --- |
| HTTP, MCP, plugin-package, pubsub, storage, checkpoint, and console protocols | Meshrix protocol and technical documents | Implemented scope is defined only by the owning documents and schemas. |
| Upstream service publishing | Meshrix server gateway and Operation Permission | Server-side functional target; compatible external-service adoption is independently owned. |
| Downstream client protocol | Meshrix generic protocol, authorization, credential, cache, proxy, and lifecycle boundary | Neutral-peer verification target; no client product is a Meshrix release dependency. |
| Client-specific adapters | Meshrix-Plugins | Catalog presence, packaging, publication, configuration, and real-client compatibility are separate facts owned there. |
| LicoUp | Independent human-agent client product | No source, runtime, verification, release, or support dependency. Any adoption of a Meshrix protocol is LicoUp-owned compatibility evidence. |
| MeshCore | Independent same-origin governed-effect product | Not a Meshrix component, backend, reduced distribution, or compatibility substitute. Its evidence cannot promote Meshrix. |
| Optional parsers, providers, datastores, and service adapters | Owning plugin or service repository | Disabled or absent by default; each enabled path needs its own contract and evidence. |
| Pactium | Exact dependency and protocol identities declared by Meshrix manifests and version registry | Dependency compatibility is limited to the exact declared identities; it does not establish Meshrix release or environment support. |

## MCP client targets

Meshrix-Plugins may package adapters for OpenClaw, Codex, Claude Code,
Antigravity, OpenCode, Pi, Kimi CLI, or other clients. Meshrix verifies
only its neutral connector boundary. A client becomes supported only when the
adapter owner names the exact client version and configuration, publishes the
exact adapter artifact, and provides current lifecycle evidence. This
repository does not currently make those client support claims.
