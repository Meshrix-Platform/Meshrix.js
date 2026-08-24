# Upstream Service Publishing Contract

## Contents

1. [Purpose and actors](#purpose-and-actors)
2. [Canonical terms](#canonical-terms)
3. [End-to-end publishing flow](#end-to-end-publishing-flow)
4. [Security contract](#security-contract)
5. [Revision and failure semantics](#revision-and-failure-semantics)
6. [Ownership and interface boundaries](#ownership-and-interface-boundaries)
7. [Downstream protocol delivery](#downstream-protocol-delivery)
8. [Core release-gate scenario](#core-release-gate-scenario)
9. [Evidence contract](#evidence-contract)
10. [Documentation and migration closure](#documentation-and-migration-closure)

## Purpose and actors

Use this contract to publish an upstream REST or JSON-RPC service through Meshrix.js so authorized protocol peers can discover and invoke its operations through the governed server path.

Actors:

- **Service developer**: an authenticated maintainer authorized for one or more service identities.
- **Control plane**: validates publishing commands, resolves ownership and policy, and writes canonical manifests.
- **Manifest store**: dedicated durable storage for accepted service manifests. The gateway reads it; it does not own publishing writes.
- **Upstream gateway**: loads immutable service snapshots and performs governed forwarding.
- **Operation Permission**: owns operation identity, capability facts, grants, risk, approval, audit, and execution mediation.
- **Tag projection**: calculates which operations each organization, team, role, grant, or other governed audience may discover.
- **Downstream gateway**: carries authorized catalog queries, invocation traffic, and scoped catalog invalidation.
- **Neutral protocol peer**: verifies the published invalidation, authenticated pull, acknowledgement, disconnect, timeout, and reconnect-fence contract without implementing a product cache.
- **Platform acceptance reducer**: decides whether the entire path is eligible for release.

## Canonical terms

- **Publishing command**: the authenticated, bounded request to create, replace, disable, or republish a service revision.
- **Service descriptor**: the normalized domain object containing service identity, protocol, operations, policy references, and audience rules.
- **Manifest**: the canonical serialized descriptor accepted by the control plane. It contains references, never secret material.
- **Service revision**: a monotonic server-issued revision for one service.
- **Manifest set revision**: a monotonic revision identifying the complete accepted manifest snapshot seen by the gateway.
- **Catalog revision**: the Operation Permission revision compiled from one manifest set revision.
- **Audience projection revision**: the tag and grant visibility revision derived from one catalog revision.
- **Server publication**: the gateway snapshot, Operation Permission catalog, and affected audience projections are committed and scoped invalidations are admitted for delivery.
- **Protocol delivery cohort**: the server-owned pending revision and opaque affected-partition set bound to one authenticated protocol session.

Do not use registration, configuration-file mutation, reload, broadcast, or notification as synonyms for the complete publishing transaction. Each is only one step.

## End-to-end publishing flow

### 1. Authenticate and bind ownership

Authenticate the service developer through the server developer identity boundary. Resolve the requested service to a server-owned service identity and verify maintainer or owner authority before accepting descriptor fields.

Bind the command to:

- subject and session identity;
- service identity and expected service revision;
- idempotency key;
- allowed publishing action;
- approval requirement when policy requires it;
- audit correlation identifier.

Reject missing, stale, cross-service, ambiguous, replayed, or unauthorized bindings before parsing secret material or performing file-system work.

### 2. Validate the publishing command

Accept a closed, versioned command containing only supported fields. The command may describe:

- REST or JSON-RPC protocol and an HTTPS or explicitly permitted private target;
- operations, HTTP methods or RPC method names, normalized relative paths, request and response schemas;
- credential and certificate references;
- required scopes, risk, approval, response projection, and redaction policy;
- token-bucket and concurrency limits;
- organization, team, role, grant, or other governed audience expressions;
- health and timeout policy.

Reject unknown fields, duplicate object keys, invalid Unicode or control characters, excessive sizes, excessive nesting, invalid identifiers, overlapping operation keys, unsupported schema constructs, unsafe targets, and policy references outside the subject's authority.

### 3. Compile and persist the canonical manifest

Compile the validated command into a fresh domain object. Never merge caller objects into process-global state and never evaluate caller strings as source, template, shell, path, regular expression, environment-variable name, or header name.

Derive filenames and directories from server-owned opaque identifiers. Write through a dedicated control-plane identity using this durability sequence:

1. Open a private staging file without following symbolic links.
2. Write the complete canonical serialization with restrictive mode.
3. Synchronize the file.
4. Validate the staged bytes, digest, revision, and schema again.
5. Atomically replace the manifest entry.
6. Synchronize the containing directory.
7. Publish the manifest-set revision.

The gateway runtime identity receives read and directory-traverse rights only. Store audit, metrics, locks, watcher state, and other mutable runtime data outside the manifest root.

### 4. Load an immutable gateway snapshot

Watch the manifest directory, not an arbitrary caller path. Treat file-system events only as invalidation hints: debounce them, rescan the complete canonical set, validate every changed manifest, and compare revisions and digests.

Build a new immutable snapshot off the request path. Verify service uniqueness, operation uniqueness, secret-reference shape, target safety, and policy completeness before swapping one atomic snapshot reference. Never partially mutate the live registry.

On validation failure, preserve the previous snapshot and publish a redacted failure event. On success, expose the manifest-set revision to downstream compilers.

### 5. Refresh Operation Permission

Compile every enabled operation into exactly one primary operation and capability identity. Include:

- service and operation identity;
- protocol and normalized route identity;
- required scopes and allowed toolsets;
- risk and approval requirements;
- credential and certificate binding references;
- request and response schemas;
- response projection and redaction policy;
- audience policy reference;
- originating manifest-set revision.

Replace the catalog atomically. The catalog revision must identify the gateway manifest-set revision from which it was compiled. Do not announce success when the gateway and Operation Permission revisions disagree.

### 6. Publish the catalog revision

After the catalog commit, emit one internal catalog-changed event containing stable identifiers, the prior and current catalog revisions, affected service identities, and a redacted reason. Modules and plugins subscribe through declared ports rather than importing catalog state or a gateway registry.

Events are invalidation signals, not data replication. Subscribers pull their authorized projection from the owning catalog.

### 7. Recompute tag-scoped discovery

For every affected grant or audience partition, evaluate organization, team, role, direct grant, deny tags, required tags, inherited tags, risk limits, scopes, toolsets, credential bindings, and policy revision.

Use deny precedence and fail closed on stale or unavailable tag state. Apply the same result to discovery and execution. An operation denied at execution must not disclose its name, description, schema, target, or policy metadata during discovery.

Notify only affected active downstream connections. The notification contains the new catalog and audience projection revisions plus a fixed reason; it contains no operation schemas, credentials, certificate data, raw tags, or user data.

### 8. Deliver the catalog through the protocol

The server publishes one closed wire contract:

1. Negotiate the catalog-change capability on an authenticated connection bound to an opaque protocol session.
2. Deliver revision-only invalidation to affected opaque partitions without grant identity, tags, catalog tools, or credentials.
3. Expose authenticated `tools/list` retrieval with the current source, catalog, audience, and partition revision facts.
4. Accept acknowledgement only when the grant, session, revision chain, and exact affected-partition set match a pending cohort.
5. Disconnect retired grants, fence acknowledgement timeouts, and reject reuse of a timed-out protocol session while allowing a fresh session to reconcile.

Core verifies this contract with a neutral peer and a frozen wire corpus. Client
cache replacement, UI, packaging, lifecycle, compatibility, and adoption
evidence remain outside the Core JSON report and readiness reducer. The
separate pre-release visual journey exercises every detected supported local
client as an operator compatibility matrix, but that evidence cannot promote,
replace, or modify the Core result.

Simulation is forbidden when any supported protocol version has a real
consumer. A protocol simulation fallback is allowed only after the complete
protocol-version scan records every row as `not_detected`; the fallback
remains explicitly identified as protocol-path evidence rather than consumer
compatibility.

## Security contract

### Input isolation

- Parse from bytes with explicit total-size, nesting, collection, and string limits.
- Reject duplicate keys and prototype-mutating names such as `__proto__`, `prototype`, and `constructor` at every object depth.
- Use closed object schemas and reject unknown properties.
- Normalize identifiers into a restricted alphabet and length; do not use display names as identifiers.
- Normalize paths as relative API paths only; reject schemes, authorities, backslashes, dot segments, encoded traversal, and controls.
- Restrict methods, protocols, auth types, header bindings, and policy kinds to server-owned enums.
- Compile request and response schemas through a safe, bounded schema subset.

### Credential and certificate isolation

- Store only typed references in manifests.
- Bind each reference to service, host, protocol, scopes, intended usage, and expected revision.
- Materialize a reference only after authentication, Operation Permission, tag policy, risk, and approval allow execution.
- Do not accept private keys, bearer values, passwords, or certificate bodies in publishing commands, logs, audit, reports, process arguments, or environment variables.
- Keep rotation and revocation in the secret authority; a changed reference revision invalidates the affected gateway session generation.

### File-system isolation

- Use separate configuration and runtime-state roots.
- Allow writes only to the control-plane identity; allow reads only to the gateway identity and explicitly authorized diagnostic tools.
- Reject symlinks, hard-link surprises, non-regular files, ownership mismatches, unexpected modes, and paths escaping the configured root.
- Validate the opened file identity, not only a path checked before open.
- Use deterministic canonical serialization so the digest and revision bind exactly the loaded bytes.

### Network and response isolation

- Reuse the canonical SSRF, DNS pinning, redirect, size, timeout, cancellation, response-schema, public-field projection, and sensitive-field redaction boundaries.
- Require an explicit deployment policy for private-network targets; never infer it from a URL.
- Ensure authorization and approval finish before credentials are materialized or a network/process side effect is possible.

## Revision and failure semantics

Model the publishing transaction with these logical states:

```text
received -> validated -> authorized -> persisted -> gateway_loaded
         -> catalog_published -> audiences_published -> server_published
```

Any step may move to `rejected` before persistence or `failed` afterward. A post-persistence failure rolls back or supersedes the incomplete manifest revision so the previous fully published revision remains authoritative.

The control plane exposes asynchronous state rather than holding an HTTP request open indefinitely:

- `accepted` means authentication, ownership, authorization, and command validation succeeded and the transaction has an identity.
- `publishing` means at least one durable or runtime stage is still advancing.
- `server_published` is the Core terminal success. The gateway, catalog, audience, and protocol-delivery revision facts agree, and any unacknowledged connection is subject to the server timeout and reconnect fence.
- `rejected` and `failed` are terminal non-success outcomes. A client-convergence deadline records lag and leaves the transaction at `server_published`; it does not roll back a safe server publication or falsely report convergence.

Required invariants:

- Revisions increase monotonically and are never reused.
- Repeating an idempotency key with the same canonical command returns the same result; reusing it with different content is rejected.
- The gateway never serves a partially built snapshot.
- Operation Permission never exposes facts compiled from a gateway revision it cannot identify.
- Audience projection never advances beyond the catalog revision it evaluated.
- An acknowledgement applies only to the exact pending revision and affected-partition set. An older acknowledgement cannot cancel the timeout for a newer pending revision.
- Disable removes discovery before new execution and prevents stale cached invocation from passing server authorization.
- Rollback never reactivates revoked credentials or a superseded policy revision.

## Ownership and interface boundaries

| Boundary | Owner | Declared interface |
| --- | --- | --- |
| Developer authentication and service ownership | Core security/control plane | Authenticated publishing command port |
| Descriptor normalization and validation | Core gateway domain | Pure compiler returning canonical descriptor or typed rejection |
| Manifest persistence | Core control-plane infrastructure | Durable manifest writer; no gateway mutation API |
| Manifest observation and snapshot swap | Core gateway runtime | Revisioned snapshot source |
| Operation projection | Operation Permission | Atomic catalog replacement port |
| Tag and grant projection | Operation Permission/security | Subject-aware discovery query and affected-audience reducer |
| MCP notification | Core protocol adapter | Grant-scoped catalog invalidation port |
| Protocol delivery verification | Core protocol adapter | Frozen wire contract and neutral-peer exchange |
| Workflow task and skill | repository-local maintenance | Catalog entries only |
| Final readiness | Core acceptance reducer | Registered report and reducer criterion |

Keep protocol adapters free of gateway and Operation Permission internals. Bind ports in the server runtime composition root.

## Downstream protocol delivery

Partition server projections and delivery cohorts by the minimum opaque server key:

```text
(grant digest, protocol session, audience partition, catalog revision)
```

Use maps keyed by stable operation identity and opaque partition to support linear snapshot compilation and constant-time targeting. Avoid repeated full scans during each tool call; compile immutable visibility sets when a relevant catalog, grant, or tag revision changes.

Bound notification and refresh concurrency:

- one pending acknowledgement timer per active protocol session;
- a finite notification queue per connection;
- monotonic revision coalescing;
- a timeout and same-session reconnect fence;
- no unbounded retry loop;
- server-side authorization on every execution regardless of peer state.

## Core release-gate scenario

The canonical gate uses a self-contained fixture and isolated temporary roots. It performs one real closed-loop scenario with positive, negative, update, disable, and recovery assertions.

### Fixture setup

- Start a deterministic REST fixture with read-only and state-changing operations.
- Create a developer identity owning one service and a second identity that does not own it.
- Create two downstream grants with different organization, team, and role tags.
- Open authenticated downstream protocol connections with a protocol-owned neutral peer.
- Create typed secret and certificate references without exposing their material.

### Publishing assertions

1. Reject unauthenticated, cross-owner, stale-revision, replay-conflict, unknown-field, duplicate-key, prototype-key, path, command, environment, header-name, oversized, and raw-secret inputs.
2. Publish a valid descriptor through the real control-plane API.
3. Verify canonical bytes, restrictive ownership/mode, absence of secret material, and separation from runtime state.
4. Verify the gateway advances to the manifest-set revision without restart and continues serving the prior revision during compilation.
5. Verify Operation Permission advances to a catalog revision bound to that manifest-set revision.
6. Verify the allowed grant discovers the operation and the denied grant cannot discover its name or schema.
7. Verify only an affected connection receives invalidation, performs authenticated catalog pull, and submits an exact acknowledgement.
8. Invoke the operation through the published protocol and prove authorization, credential binding, response projection, audit correlation, and expected fixture side effect.
9. Update the route or policy and prove one new server revision while stale or malformed acknowledgements cannot advance delivery state.
10. Disable the service and prove discovery removal, execution denial, scoped invalidation, and server terminal-state rules.
11. Submit an invalid replacement and prove the previous accepted revision remains authoritative without a partial catalog or protocol state.
12. Disconnect or time out a peer, reject reuse of its fenced session, and allow a fresh authenticated session to pull the current revision.

### Gate outcome

The capability gate is ready only when every assertion above uses production entrypoints and all resulting reports pass leak scanning. Mocks may isolate the upstream fixture transport, clock, or file-system notification timing, but may not replace the control-plane API, manifest writer/loader, catalog refresh, tag projection, protocol notification, neutral peer, or server composition.

## Evidence contract

The Core JSON report emits only minimum evidence:

- schema version and verifier identity;
- manifest, catalog, audience, and protocol-delivery revision relationships;
- counts of accepted, rejected, notified, pulled, acknowledged, disconnected, fenced, denied, and executed operations;
- boolean security and redaction assertions;
- fixed reason categories;
- irreversible digests of synthetic fixture identities when correlation is necessary;
- duration and bounded resource metrics.

Never emit absolute paths, usernames, host identity, service URLs, raw manifests, operation payloads, tag values, grants, tokens, keys, certificates, cookies, ciphertext, or backend rows.

The capability report is evidence input only. Register its command and report with the core acceptance command catalog, required-report validator, readiness reducer, private-deployment aggregate, capability acceptance checkpoint, test registry, package script registry, and repository-local maintenance workflow catalog. Only the platform acceptance reducer may produce the release-ready claim.

The mandatory pre-release HTML is a separate human-readable projection. Its
tracked blank template is the public structural contract, not evidence. Change
the skill and this contract first, then the blank template and its deterministic
`--check` generator, then the renderer and focused tests, and only then
regenerate the local report from verified evidence. Template verification is an
explicit dependency of both the Core publisher and the runtime journey; task
array order and a shared resource lock are not ordering contracts. The Core
report, final candidate receipt, and runtime report outputs are bound by byte
length and SHA-256. The blank template remains portable, offline, bilingual,
synthetic, and visibly marked `Not executed / 未执行`; it contains no real
screenshot, digest, runtime value, private path, or `build/` artifact reference.

The catalog exposes two separate execution lanes. The side-effecting
`upstream-service-publishing` lane is the only producer of a fresh external
service, Console, client, screenshot, and portable-report bundle. Run it before
every release candidate with explicit side-effect admission. The
`upstream-service-prepublication` lane starts no runtime component and consumes
only an already-produced complete bundle. It fails closed on missing, stale,
dirty-candidate-bound, privacy-unsafe, reordered, or digest-mismatched inputs
and writes a bounded receipt. It cannot claim `functional-complete`, overall
`releaseReady`, or replace the platform reducer. Do not add the runtime journey
to tag CI by checking out floating sibling repositories. It may move there only
after the converter image and adapter bundle have immutable coordinates
published by their owners.

The generated HTML includes a mandatory published-upstream-interface catalog
derived only from the exact publication JSON bytes used by the journey. It
verifies the bytes against the journey's byte length and SHA-256, then lists
the health route and every operation with operation key, method and path,
approval behavior, request/upload representation and limits,
response/download representation and limits, byte-range support, scopes, risk,
and timeout. Each row states that the interface shape is forwarded through the
governed Meshrix.js gateway. An artifact response is not presented as an invented
standalone download endpoint. A missing, blank, duplicate, stale, or
digest-mismatched catalog fails the report.

The generated HTML is one portable file. Before projection, verify the exact
PNG signature, declared byte length, and SHA-256 of every screenshot, and
verify the exact byte length and SHA-256 of the actual publishing JSON. Embed
the verified screenshots as `data:image/png;base64` URLs and the downloadable
JSON as a `data:application/json;charset=utf-8;base64` URL. Do not retain
relative or absolute file dependencies, `blob:` URLs, external fonts,
stylesheets, scripts, images, or network resources. A copy of only the HTML in
an otherwise empty directory must retain all images, styles, localization, and
the JSON download. The source JSON, screenshot files, and reducer reports
remain the evidence authorities; embedding only makes their human-readable
projection portable.

Keep exactly two declared top-level sections in order: `operation-guide` and
`appendix`. The first main-content section is an operator manual built from the
eleven verified Console checkpoints. Each step binds one screenshot to four
required bilingual fields: Console location, operator action, generated result,
and purpose. State the human-facing menu path and stable route. The screenshot
must appear inside its matching step instead of in a detached evidence gallery.

The operation guide contains exactly four ordered semantic subsections while
preserving the global eleven-step numbering and screenshot order:

1. `organization-structure-configuration`: authenticated Workbench and the
   published organization/permission projection;
2. `upstream-service-registration-publishing`: service descriptor, operation
   mapping, and publication/runtime health;
3. `tool-permission-configuration`: published tool projection and API Key
   generation;
4. `mcp-service-request`: downstream-agent configuration, pending and completed
   operation approval, and the final MCP call audit.

Each subsection has a stable id, bilingual heading and purpose, its own grouped
index, and only the step cards assigned to that group. Grouping may not reorder,
duplicate, omit, or renumber evidence. Group headings must remain visually
distinct from step headings in screen, narrow-viewport, and print layouts.

Place all non-procedural material in the final appendix: candidate scope,
execution summary, startup and connector configuration, published interface
catalog, client matrix, golden path, requirements, production boundaries,
revision semantics, protocol delivery, provenance, timings, and cleanup. Keep
the cover limited to the manual title and one short scope sentence. Generate
navigation from the two-section contract and provide ordinary fragment links,
a skip link, one `main` landmark, stable section IDs, and a bilingual caption
for every table. Place verified publication/runtime health beside the interface
catalog inside the appendix. The client matrix projects discovery, install,
upload, tools/list, both operation branches, uninstall, and cleanup. Provenance
projects only stable step IDs, statuses, bounded durations, and cleanup status;
it does not expose receipts or error messages. Each evidence image includes its
physical dimensions and uses lazy loading plus asynchronous decoding, while
print styling forces deferred content visible.

A successful HTML headline is scoped to the upstream publishing journey. The
document must say that only the platform acceptance reducer can declare overall
functional acceptance. Candidate coordinates may be projected only from
explicit renderer input. The HTML never owns candidate status. Render the final
HTML first, then create the external candidate receipt that binds those exact
bytes; never embed the final receipt digest into the HTML and create a recursive
digest dependency.

On failure, write a portable, visibly failed, non-authoritative HTML at the
canonical path and keep the verifier exit non-zero. Include only the stable
failed stage code, bounded step/cleanup status and duration, and fixed recovery
guidance. Exclude failure messages, step receipts, logs, screenshots,
configuration attachments, partial success claims, and runtime data. The
presence of this diagnostic projection cannot promote evidence.

Each live Console screenshot uses a `1440 × 1000` CSS-pixel viewport and device
scale factor `2`, yielding a `2880 × 2000` PNG. The screenshot manifest records
the CSS viewport, device scale factor, and physical pixel dimensions. Validate
the PNG IHDR dimensions against those facts before accepting or embedding the
image. Do not resize or upscale an earlier 1× capture to meet the 2× contract.

Before it may be generated, run an isolated real external service, the Meshrix.js API and
Web Console, and the operator-owned connector compatibility matrix organized by
**MCP protocol version**, not by agent product. Resolve the supported protocol
versions from the canonical protocol definition; each matrix row is one
protocol version. For every supported version, use a real consumer that speaks
that version as the verification sample: issue an organization-scoped API Key
through the rendered Console, install through token-env or token-stdin in an
isolated temporary configuration, request, uninstall, and clean up every
detected consumer. Every detected consumer must pass; the report retains every
protocol-version row and records a version with no real consumer as
`not_detected`. Do not use simulation to replace, supplement, or rescue a real
consumer when at least one version has one.

Only when every protocol-version row is `not_detected`, run one isolated MCP protocol
simulator through the same upload, tools/list, two-operation, approval, audit,
screenshot, and cleanup path. Record validation mode `simulated-fallback` and
reason
`no_supported_local_client_detected_after_complete_protocol_scan`. Display the
simulator as `mcp-simulator`, never as a specific product, and
state that consumer compatibility remains remaining required work until a real consumer is qualified. Record the exact safe startup and connector configuration as
selectable text. Capture Chromium screenshots from the running Web Console for
the default Workbench, descriptor configuration, publication health, operation
projection, API Key issuance and downstream configuration, Operation Permission approval, and the final downstream
MCP call matrix. The operation-configuration screenshot must
visibly show the imported `artifact_multipart` request representation and its
configured multipart request `maxBytes`; an empty manual-operation form or
placeholder defaults are invalid evidence. Bind every image by a cryptographic
digest in the journey report and embed its verified bytes as a PNG data URL in
the single-file report.

The descriptor projects the same external `POST /v1/convert` route as two
different internal operation identities. `convert-require-approval-debug`
requires approval and must show zero successful executions before approval and
exactly one after approval for each detected target.
`convert-full-access-debug` omits the approval wait only; Grant, scope, risk,
audience, service, owner, permit, audit, and protected-sink enforcement remain
mandatory.

Each real or simulated execution target's connector discovery bootstrap requests
`meshrix.agentWorkspace.list`. The journey Grant intentionally excludes
workspace authority and the verifier requires exactly one
`missing_capabilities` denial for each execution target. The HTML identifies
these records as expected non-amplification evidence, separate from the two
successful format-convert branches.

The journey uploads its tracked source document through the authenticated
upload-session API as raw `application/octet-stream` chunks. The downstream
MCP call receives only the owner-bound
`upload:<session-id>:<file-index>` reference; the gateway resolves it and
streams the configured `artifact_multipart` request to the external service.
The gate fails if it instead places file bytes in a Base64 JSON field. Report
the external service file budget separately from the larger multipart
request-envelope `maxBytes`; that envelope limit is not a global Meshrix.js upload
limit. The connector grant uses only the dedicated
`meshrix.uploads.write` / `uploads:write` safe-write authority for the upload
data plane and must not acquire the repair-capable Jobs write surface.

The report and screenshots are local-only generated artifacts under the
repository's Git-ignored `build/` tree. The journey preflight must verify that
the complete tree remains ignored. Synthetic fixture URLs, generated service
identities, catalog digests, and tool identities are evidence and remain
visible. This local-only boundary does not permit credentials or protected
backend data to enter the report.

The single offline HTML contains complete English and Simplified Chinese
operator copy and exposes a right-aligned language switch. It loads no external
script or resource. One closed inline language controller may update only
declared text nodes, the document `lang`, and the switch's pressed state. It
must not use network APIs, storage APIs, dynamic evaluation, or HTML injection.

The visual journey fails closed when a required screenshot is missing,
duplicate, blank, reordered, stale, digest-mismatched, or privacy-unsafe.
Screenshots must be pixels from live product pages. A generated receipt card,
status page, manually assembled success image, mock Console, or DOM-only
snapshot is invalid. The Console may display the tracked synthetic
format-convert descriptor, including its fixed Compose service target, because
that is the configuration under test. Screenshots must protect password fields,
issued tokens, authorization codes, authorization request identities, process
fingerprints, execution identities, trace identities, cookies, account
metadata, and other protected values. They must
not expose machine identity, account metadata, private paths, raw client
configuration, requests, responses, documents, logs, shell output, or backend
payloads. A screenshot is visual evidence for the demonstrated journey
only; it never becomes Core reducer authority.

The screenshot manifest contains exactly eleven ordered live Console states:
authenticated default Workbench, published organization/permission projection,
basic descriptor, operation mapping, publication health, tool projection,
issued API Key record after permanent dismissal of the one-time secret,
privacy-safe downstream-agent configuration after the real token-env or
token-stdin handoff, pending operation approvals,
completed operation approvals, and the downstream call matrix. The organization
evidence must visibly bind hierarchy, governed tags, and administrator roles.
The API Key evidence must visibly bind the organization-scoped issued record
while masking credential and workload identifiers and must never contain the
plaintext key.

The final
`build/reports/upstream-service-publishing-candidate.json` receipt binds one
release-definition version and tag, exact source commit and tree, Core report,
journey report, actual publishing JSON, final HTML, and the eleven ordered PNGs.
Each artifact binding contains only a repository-relative path, byte length,
and SHA-256. The receipt itself has a canonical SHA-256 and the fixed scoped
claim `upstream-publishing-prepublication-passed`. It contains no raw report,
runtime payload, URL, account fact, local path, host fact, or whole-project
readiness field. A tag resolving to another commit, a dirty worktree, a stale
journey candidate, a changed byte, an unknown artifact, or a privacy-unsafe
artifact fails verification without redisclosing the offending value.

## Documentation and migration closure

Maintain these document owners when implementation makes the facts true:

- gateway lifecycle and forwarding: `docs/functionality/GATEWAY.md`;
- operation catalog, tags, and publication: `docs/functionality/OPERATION-PERMISSION.md`;
- developer identity, service ownership, secrets, certificates, and audit: `docs/functionality/SECURITY-AUTHORIZATION.md`;
- composition, watchers, snapshot lifecycle, and event ports: `docs/functionality/SERVER-RUNTIME.md` and architecture documentation;
- protocol delivery and neutral-peer verification: `docs/protocols/PROTOCOLS.md` and Core gateway documentation;
- operator and developer usage: `docs/RUNBOOK.md`;
- executable commands: core package scripts and `package.json scripts`, not copied command tables in skills.

Remove the superseded registration-lockdown verifier, report, package script, test registry entry, acceptance command, report specification, reducer condition, capability checkpoint, state-machine definition, plan directory, and documentation wording in the same migration. Keep no compatibility alias or permanent absence check.
