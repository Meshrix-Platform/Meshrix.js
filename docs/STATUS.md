# Meshrix.js Status

Status follows the source, published artifacts and candidate-bound verification.
A plan describes intended work; completing a plan does not establish a working
deployment or extend an earlier candidate's acceptance to later source.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Published products** | `meshrix.js@0.1.0` and `@meshrix/gateway@0.1.0` are published. GitHub release `v0.1.0` is available. See [release history](releases/README.md) for the public references. |
| **Implementation** | The Node.js platform includes the Server, Web Console, storage, jobs, governed operation dispatch, standard MCP ingress and the plugin contract. Optional plugins, independent services and external clients keep their own lifecycles. |
| **Current source** | Post-release source changes require their own affected verification. Published `0.1.0` artifacts, prior source checks and earlier deployed instances do not establish the present candidate's runtime or cloud readiness. |
| **Deployment** | The maintained Node.js and container paths remain the current implementation. The private relay runs on Cloudflare Workers staging (Free plan): `wss://relay.meshrix.io` plus its `workers.dev` fallback, with a complete peer e2e verified against the live route (commit `e4f9dacf`). The `/admin/*` control plane is deployment-gated and closed by default (`RELAY_ADMIN_SURFACE`, commit `2e580187`): the staging route answers 404 for admin paths even with a valid bearer — public routes carry no control plane. Forged session upgrades are rejected at the worker edge before any Durable Object instantiation via HMAC credential tickets (`RELAY_TICKET_SECRET`, commit `d0c28627`, live-verified 401), with a per-source failure damper and vault pre-checks bounding the remaining surface. Remote admin on staging awaits a Cloudflare Access-protected hostname plus `RELAY_ADMIN_SURFACE="access"`; private/self-hosted deployments keep the bearer-gated `"local"` shape. Native SQLite, filesystem and process assumptions for the broader Node.js platform still require deliberate runtime adapters. |
| **Privacy and enterprise operation** | The existing semantic gateway interprets invocation data. Transport TLS, a private network and encrypted secret storage do not establish forwarding that hides content from the operator. Authenticated personal endpoint pairing, operator-blind content forwarding and independently selectable enterprise recording categories are planned capabilities, not current release claims. |
| **Verification** | Use the repository-owned verification workflow and the smallest affected engineering closure. The product-level functional gate is `npm run verify:acceptance`; benchmarks require current same-candidate backend, Console, standard MCP and normal-shutdown evidence. |

## Publication and support boundary

The published `0.1.0` products cover the single-node Core platform with Web
Console, standard MCP access, governed upstream services and the independently
embeddable gateway within their documented artifact and environment support.
Hosted Workers operation, application-layer operator blindness, multi-node
availability and a dedicated enterprise deployment are separate qualification
claims. Project-owned source is Apache-2.0; independent dependency and asset
licenses remain applicable.

The standard release workflow builds, checks, packs and smoke-installs the two
products from a selected version tag, then performs npm publication and creates
the GitHub Release. The first publication is complete; subsequent source work
must preserve actual published contracts and use the normal release path. A
local build, a branch comparison or an npm archive does not publish a new version.

## Development direction

The current programme prioritizes product completeness, reliability, privacy,
operational control, efficiency and first-use quality. Initial shared hosting
targets Cloudflare Workers. Enterprise operators should be able to self-host the
platform and control recording categories, destinations and retention using their
own resources. Dedicated Workers, Containers or other infrastructure follow an
actual deployment requirement.

Personal privacy depends on authenticated endpoints holding decryption keys,
not on a server-side audit switch. A content-blind relay can still observe
connection metadata or retain ciphertext. Enterprise content processing and
audit explicitly trust the organization's selected administrator and endpoint.
The future recording design must distinguish execution state required for
authorization and recovery from optional retained audit, and migrate the owning
contracts with its implementation. The current
[minimum-evidence contract](architecture/GOVERNED-EXECUTION-AND-MINIMUM-EVIDENCE.md)
continues to describe the existing implementation boundary; planned changes are
not already implemented behavior.

Reliable autonomous Peer communication and useful gateway discovery, CLI and
result-consumption improvements remain in the current programme. Receiving a
message does not authorize execution or remote control. Exact cryptographic,
storage and host-integration choices remain open until their owning design work
establishes them. The private repository-local planning entry is
`docs/plans/Programme.json`; no future milestone is activated by reading it.

## Evidence and remaining qualification

Earlier candidate evidence includes deterministic gateway authorization,
cancellation, durable-effect and recovery checks, plus a bounded Core, Console
and standard MCP upstream journey. Those observations remain bound to their
original source and configuration. Historical failed attempts remain failed;
publication does not rewrite those attempts or prove every future environment.

The current source needs its own affected verification and functional evidence
before performance work, as defined in
[the repository rules](../AGENTS.md#functional-availability-before-benchmarking-and-optimization).
There is no current evidence here for comparative industry-leading performance,
absence of all security vulnerabilities, a complete operator-blind Workers
deployment or actual autonomous host wake-up.

Future real-cloud verification proceeds through authorized isolated targets and
the actual Workers runtime before public rollout. A private-network laboratory
can test endpoints and failure behavior, but it does not substitute for Workers
qualification. Real Agent conversations and live use belong to separately
assigned acceptance tasks. Deployment, procurement, publication and access to
private runtime data remain their own authorization boundaries.
