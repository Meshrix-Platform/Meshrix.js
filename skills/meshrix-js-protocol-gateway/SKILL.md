---
name: meshrix-js-protocol-gateway
description: Maintain Meshrix.js downstream and upstream gateway behavior, including MCP ingress and egress, ACP relay carrying, external-service routing, identity propagation, filtering, audit, and protocol conformance. Use for gateway protocol or integration changes in the core repository.
---

# Meshrix.js Protocol Gateway

Buffered JSON, opaque streaming, multipart, MCP, asynchronous, and artifact
transit may use different data-plane adapters, but they must enter the same
governance prepare step and present the same typed permit to the first network,
credential, artifact-read, or artifact-write sink. A controller-local policy
check or transport label is not a second authorization path.

## Preserve protocol ownership

Treat external protocols as independent contracts. Implement compatible transport, routing, authorization, governance, audit, and conformance around them without redefining them.

Keep downstream client identity distinct from upstream provider credentials. Keep install and configuration proof distinct from provider-account proof.

For encrypted client-to-client relay content, never add a server capability
that reveals plaintext. Decode only messages explicitly addressed to the
server. external client protocol solely owns Pairwise Protection, Generic Message,
Reliable Exchange, profile negotiation, Transport Profiles, and all wire,
lifecycle, and conformance semantics. external client owns endpoint private keys and
secrets, local Provider selection and state, plaintext and history, peer trust,
approval, local effects, and execution of one exact pinned Protocol Line.
An external relay is untrusted and opaque. Meshrix.js gateway behavior must not claim
any of those authorities, negotiate on behalf of endpoints, translate Protocol
Lines, or provide a dual-stack compatibility path.

## Implement safely

Use canonical protocol descriptors and registries. Reject unregistered or unauthorized capabilities fail-closed. Apply response filtering before evidence or audit persistence.

Keep provider-specific implementations outside the default runtime and keep
generic gateway contracts in core.

Use `npm run verify:upstream-gateway` before execution. External or live-provider tasks require `--allow-side-effects`.
