# Meshrix.js Compatibility

This document records compatibility implemented by the current source tree.
It does not create a support claim for a package, platform, or deployment
profile. The [release record](releases/README.md) identifies published `0.1.0`
artifacts and the unpublished `0.2.0` source candidate. Use evidence for the
exact artifact rather than treating current source behavior as already released.

## Runtime and deployment boundaries

| Surface | Current source contract |
| --- | --- |
| Node.js | The root `package.json` declares `>=22.19.0 <23 || >=24.3.0 <25`. |
| Server and Console | The server serves the Console at `/` and its API at `/api/` from one origin. The default local port is `7228`; source development may use a separate Vite port for hot reload. |
| MCP ingress | `/mcp` supports the native Streamable HTTP tools profile with `initialize` / `notifications/initialized` and versions `2025-11-25`, `2025-06-18`, and `2025-03-26`. The published modern `2026-07-28` profile retains its strict metadata/header contract. Both use the same authorized catalog and invocation path. |
| MCP connector stdio | The shared connector exposes the standard `2025-11-25` tools profile, negotiates initialization locally, and forwards authorized tool work using the modern HTTP profile. This boundary is independent of client product identity. |
| MCP upstream | Configured upstreams support modern HTTP `2026-07-28` discovery. The legacy upstream transport supports HTTP and local stdio protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`. These legacy upstream paths do not define a legacy downstream server. |
| Storage | Self-contained local storage is the default. Optional stores or services are active only when explicitly configured and require evidence for the exact integration. |
| Ingress | The runtime supports an administrator-managed TLS-terminating proxy under the documented trusted-forwarding contract. Forwarded headers do not establish identity or authorization. |
| Plugin UI | Plugin browser content runs in an opaque-origin iframe and communicates through the versioned Host bridge. This boundary does not grant direct network access or same-origin privileges. |
| npm products | The supported npm products are `meshrix.js` and `@meshrix/gateway`. Root-installed first-party client adapters are private components bundled with `meshrix.js`. Package manifests and the release definition own product names and versions; a source checkout, local build, or local installation is not proof of registry publication or external platform support. |

## Native client registration

A conforming MCP client can use the `/mcp` URL directly; no Meshrix device-side
proxy or credential daemon is required. Ordinary scoped API Keys must resolve
to `X-Meshrix.js-Api-Key`, not `Authorization: Bearer`. Optional client identity
may be absent; process identity remains mandatory when required by the selected
key's policy.

The installer writes a native endpoint and an explicit protected environment
reference for Codex, Claude Code, OpenCode, OpenClaw, and Pi. It neither stores a
raw key in client configuration nor provisions a persistent client environment.
`configured` means the selected entry matches; credential availability in the
client is `external-reference-unverified`, and native connectivity is `not-run`.
An installer service probe is not a native-client connectivity result.

Kimi Code 2.2.0 has literal custom headers; its `bearerTokenEnvVar` supplies only
Authorization and cannot satisfy this header contract. Antigravity 2.24.0's
ordinary headers are also literal. Its separate plugin credential mechanism has
not been qualified for this exact protected-key binding, so the adapter refuses
that combination rather than claiming every native credential mechanism is
unsupported. Its current default configuration is
`~/.gemini/config/mcp_config.json`. Unsupported installs fail before mutation;
conflicting registrations and unrelated user configuration are preserved.

The optional explicit stdio connector remains an independent transport. It is
not installed as a fallback for an unsupported native registration.

## Protocol and integration ownership

Compatibility is directional. The protocol adapter owns parsing, negotiation,
and transport state. Authorization and capability decisions remain in the
governed runtime, and upstream integrations are enabled explicitly rather
than discovered from a client-brand catalog.

| Boundary | Ownership |
| --- | --- |
| HTTP, MCP, plugin package, pubsub, storage, checkpoint, and Console protocols | The owning Meshrix.js protocol documents and schemas define the implemented wire contract. |
| Upstream service publishing | The server gateway and Operation Permission own publication and governed invocation. An upstream's own availability and protocol conformance are external conditions. |
| Downstream client integration | `meshrix.js` contains the first-party adapter components for its declared target catalog. Each runs only for an explicit target action through the bounded JSON-stdio contract; client applications remain independent external products. |
| Optional parsers, providers, datastores, and service adapters | Optional integrations are disabled or absent by default. Each enabled implementation has its own contract, configuration, and verification evidence. |

The root package and Foundation declare `pactium@0.8.4` as a runtime
dependency, and `package-lock.json` pins the resolved package. The separate
`vendor/pactium-0.8.0.tgz` source archive is not that runtime dependency; its
license and inclusion in a release artifact must be assessed independently.
The project's Apache-2.0 declaration does not determine the license
obligations of third-party artifacts in a distribution.
