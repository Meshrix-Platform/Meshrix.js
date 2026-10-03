# Meshrix.js Compatibility

This document records compatibility implemented by the current source tree.
It does not create a support claim for a package, platform, or deployment
profile. Meshrix.js is preparing its first npm release; use release evidence
for the exact published artifact when it becomes available.

## Runtime and deployment boundaries

| Surface | Current source contract |
| --- | --- |
| Node.js | The root `package.json` declares `>=22.19.0 <23 || >=24.3.0 <25`. |
| Server and Console | The server serves the Console at `/` and its API at `/api/` from one origin. The default local port is `7228`; source development may use a separate Vite port for hot reload. |
| MCP ingress | The modern downstream HTTP profile uses MCP `2026-07-28`. Legacy `initialize` client sessions are not implemented at this ingress. |
| MCP upstream | Configured upstreams support modern HTTP `2026-07-28` discovery. The legacy upstream transport supports HTTP and local stdio protocol versions `2025-03-26`, `2025-06-18`, and `2025-11-25`. These legacy upstream paths do not define a legacy downstream server. |
| Storage | Self-contained local storage is the default. Optional stores or services are active only when explicitly configured and require evidence for the exact integration. |
| Ingress | The runtime supports an administrator-managed TLS-terminating proxy under the documented trusted-forwarding contract. Forwarded headers do not establish identity or authorization. |
| Plugin UI | Plugin browser content runs in an opaque-origin iframe and communicates through the versioned Host bridge. This boundary does not grant direct network access or same-origin privileges. |
| npm products | The supported npm products are `meshrix.js` and `@meshrix/gateway`. Root-installed first-party client adapters are private components bundled with `meshrix.js`. Package manifests and the release definition own product names and versions; a source checkout, local build, or local installation is not proof of registry publication or external platform support. |

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

The root package and Foundation declare `pactium@0.8.1` as a runtime
dependency, and `package-lock.json` pins the resolved package. The separate
`vendor/pactium-0.8.0.tgz` source archive is not that runtime dependency; its
license and inclusion in a release artifact must be assessed independently.
The project's Apache-2.0 declaration does not determine the license
obligations of third-party artifacts in a distribution.
