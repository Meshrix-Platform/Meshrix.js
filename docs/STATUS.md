# Meshrix.js Status

Status distinguishes source implementation, deterministic engineering checks
and published artifacts. Each result applies to the source and configuration
it exercised.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Published products** | `meshrix.js@0.3.0` and `@meshrix/gateway@0.3.0` are the published npm products (`@meshrix/gateway` is superseded by `@meshrix/kernel` at the next release). GitHub release `v0.3.0` is available. See [release history](releases/README.md). |
| **Prepared source** | The source version is recorded in [package.json](../package.json); that value does not establish publication. The source also carries the independent `@meshrix/lite` CLI package (`meshrix-lite` binary) pending its first publication. Publication evidence comes from the npm registries and GitHub Releases. |
| **Managed endpoints** | Organization-registered devices receive governed capability distribution through the managed-endpoint contracts and server-runtime dispatch. Standard MCP discovery, invocation, authorization and revocation apply to every published capability; endpoint registration, authorization receipts, result settlement and revocation are server-side governance duties. |
| **Antigravity** | The Agent adapter follows the public Antigravity ACP descriptor and explicit behavior profiles. Local subprocess fixtures exercise configuration, permissions, reservation and enrollment-to-execution behavior; they do not establish acceptance against the real Agent. Unsupported selectors remain rejected according to the selected lane and maintained card. |
| **Self-hosted runtime** | The Node.js server and optional container paths provide the framework runtime. Published packages do not supply a hosted endpoint. Public account contracts describe integration boundaries; they do not establish deployment of a corresponding service. |
| **Privacy and recording** | Self-hosted recording explicitly trusts the organization's administrator and local storage permissions; recording content does not have an independent encryption-key boundary. Policy redaction, retention and failure behavior are covered by deterministic tests. |
| **Engineering evidence** | Scoped tests and Node typechecks cover the current migration. Release packaging and clean-consumer checks apply to their exact artifacts; earlier acceptance does not establish later-source readiness. |

## Publication and support boundary

The published `0.3.0` products cover the single-node Core platform with Web
Console, standard MCP access, governed upstream services and the independently
embeddable gateway within their documented artifact and environment support.
Project-owned source is Apache-2.0; independent dependency and asset licenses
remain applicable.

The tag-driven release workflow builds, checks, packs and smoke-installs the
npm products before publication and GitHub Release creation. Preparing version
metadata does not publish another release.

## Verification scope

Managed endpoints are registered by the organization, publish capabilities,
execute admitted operations and return settled results through the server-side
governance path. Tenant isolation, TLS, authentication, authorization and
revocation remain enforced on every operation.

Real Agent conversations, provider behavior, visual acceptance, power-loss
behavior, comparative performance and deployment require their own evidence.
They are not established by source review, synthetic fixtures or a local
build. The product-level functional gate remains `npm run verify:acceptance`.
