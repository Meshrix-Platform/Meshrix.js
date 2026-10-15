# Meshrix.js Status

Status follows the source, published artifacts and candidate-bound verification.
A plan describes intended work; completing a plan does not establish a working
deployment or extend an earlier candidate's acceptance to later source.

## Current product state

| Dimension | Current status |
| --- | --- |
| **Published products** | `meshrix.js@0.1.0` and `@meshrix/gateway@0.1.0` are published. GitHub release `v0.1.0` is available. See [release history](releases/README.md) for the public references. |
| **Implementation** | The published Node.js platform includes the Server, Web Console, storage, jobs, governed operation dispatch, standard MCP ingress and the plugin contract. The current unreleased source candidate implements encrypted online-only Peer forwarding, device-local delivery custody, recoverable application events and an SQLite-backed Skill Hub registry. Relay messages are not persisted as business data; offline work remains pending on the sender until the paired device reconnects. Independent source review and scoped engineering verification are complete; all discovered failures and omitted coverage were repaired. The original failed runs remain preserved. |
| **Current source** | Post-release source changes require their own affected verification. Published `0.1.0` artifacts, prior source checks and earlier deployed instances do not establish the present candidate's runtime or cloud readiness. |
| **Deployment** | The maintained Node.js and container paths remain the current implementation. The hosted account authority, private relay and public gateway deployment is operated privately in a separate operations repository and is not part of this repository's published artifacts; no public hosted endpoint is currently offered. The private-relay wire contract in `packages/contracts/src/private-relay/` and the account contract in `packages/contracts/src/account/` define the public boundary that a hosted runtime or a self-hosted deployment implements. Native SQLite, filesystem and process assumptions for the broader Node.js platform still require deliberate runtime adapters. |
| **Privacy and enterprise operation** | The published `0.1.0` release retains its documented operator trust boundary. The current source candidate keeps Peer payloads end-to-end encrypted between paired devices and does not persist business messages or signed delivery receipts in the relay. This is not a hosted-service or privacy acceptance claim; no hosted relay service is publicly offered. |
| **Verification** | Engineering closure completed on 2026-10-12. The unique whole run remains 11 passed / 11 failed, and the affected run remains 7 passed / 2 failed. Later targeted repairs passed; the Reviewer also fixed a name-filter merge bug and completed 20 omitted files (176 current tests), repairing all three newly exposed failures and two unhandled readiness rejections. The final lifecycle tests and node/test typechecks pass. Existing valid results are reused; no second full regression ran. Raw failures, scoped successes and session-only evidence remain in the private programme records. Comparative performance, native Windows/power-loss behavior, real Agent/browser/provider acceptance and deployment remain unqualified. The product-level functional gate remains `npm run verify:acceptance`. |

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

The unreleased source candidate develops Peer communication around device-local
durable inbox/outbox state, paired-device authorization, online encrypted
forwarding, signed receipt replay with the pairing-pinned Signal identity and
locally journaled application events. Logical events can be fragmented and
reassembled locally without adding a fixed catalog-size limit. Receiving a
message does not authorize execution or remote control; only the explicit host
integration may dispatch an authorized operation. These changes have current-candidate deterministic engineering evidence;
live acceptance remains separately assigned.
The maintainer-designated private project Programme owns delivery planning;
repository-local predecessor plans remain inactive evidence. Reading a plan
does not activate a future milestone.

## Evidence and remaining qualification

Earlier candidate evidence includes deterministic gateway authorization,
cancellation, durable-effect and recovery checks, plus a bounded Core, Console
and standard MCP upstream journey. Those observations remain bound to their
original source and configuration. Historical failed attempts remain failed;
publication does not rewrite those attempts or prove every future environment.

The current source needs its own affected verification and functional evidence
before performance claims, as defined in
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
