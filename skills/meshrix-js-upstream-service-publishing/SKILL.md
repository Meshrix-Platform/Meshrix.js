---
name: meshrix-js-upstream-service-publishing
description: Run or maintain the mandatory Meshrix.js pre-release upstream service publishing producer and side-effect-free prepublication verifier, from a real external service through authenticated registration, gateway and Operation Permission publication, every detected local agent's MCP invocation, zero-client-only simulation fallback, a screenshot-complete portable HTML operation manual, and one candidate-bound receipt. Use before every Meshrix.js release candidate and for upstream onboarding, gateway lifecycle, downstream delivery, visual evidence, report-manual, or publishing-gate changes.
---

# Meshrix.js Upstream Service Publishing

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Read [references/publishing-contract.md](references/publishing-contract.md) completely when changing the capability flow, state model, security boundary, event contract, protocol delivery, or server gate.
3. Keep ownership split as follows:
   - Core owns the developer control plane, normalized service descriptor, manifest persistence contract, upstream gateway reload, Operation Permission projection, tag-scoped discovery, protocol notifications, and platform acceptance.
   - Client implementations independently own cache consumption, product lifecycle, packaging, and compatibility. Core never discovers, imports, executes, or waits for those implementations or their evidence.
   - repository-local maintenance owns this skill and the catalog-backed workflow task.
4. Use `$meshrix-js-security-authorization`, `$meshrix-js-protocol-gateway`, `$meshrix-js-operation-permission`, and `$meshrix-js-platform-acceptance-workflow` only for the Core boundaries actually changed.

## Preserve the publishing transaction

Treat one accepted service revision as one monotonic publishing transaction:

1. Authenticate the service developer and bind the request to a service owner.
2. Parse the request into a closed, versioned publishing command and authorize every declared service, operation, audience, credential reference, certificate reference, traffic policy, and risk policy.
3. Compile the command into a canonical manifest without interpolating untrusted input into paths, commands, templates, environment names, header names, or executable configuration.
4. Persist the manifest through the control-plane writer into a dedicated configuration root; keep the gateway runtime identity read-only and keep mutable runtime state elsewhere.
5. Detect the new manifest revision, validate it completely, and atomically swap an immutable gateway snapshot without exposing a partial revision.
6. Compile every operation into Operation Permission facts and publish one catalog revision only after the gateway snapshot and permission projection agree.
7. Recompute discovery visibility for each affected grant or audience from organization, team, role, and other governed tags; send scoped invalidation notifications without publishing unauthorized schemas.
8. Expose scoped revision-only invalidation, authenticated catalog pull, exact acknowledgement, grant disconnect, timeout, and reconnect-fence semantics through the published protocol; verify them with a neutral peer.

The Core terminal success is `server_published` after the gateway, Operation Permission, audience projection, and protocol-delivery facts agree. A control-plane request may return `accepted` or `publishing` while those server stages advance. Client adoption is neither a Core state nor an input to this gate. A failed server-side step must leave the previous accepted revision authoritative and emit only redacted audit facts.

## Enforce security and consistency

- Treat user input as untrusted data, not as configuration syntax. Normalize through a closed schema, reject unknown and duplicate keys, bound bytes, depth, collections, and strings, and reject prototype keys and control characters.
- Derive storage paths from server-owned identifiers. Do not accept a caller path, filename, command, environment-variable name, arbitrary header name, or template fragment.
- Store private keys, tokens, and certificate material only through typed secret references. Bind each reference to the service, target, protocol, scopes, and revision before materialization.
- Separate the control-plane writer identity from the gateway reader identity. Reject symlinks and non-regular files; validate ownership and mode before loading.
- Use durable staging, file synchronization, atomic replacement, directory synchronization, revision digests, and rollback. Do not mutate a live descriptor object in place.
- Use immutable snapshots and monotonic revisions so readers do not lock the hot path. Coalesce file-system events, but never coalesce distinct accepted revisions into an unverified state.
- Apply the same authorization and tag policy during discovery and execution. Discovery must not reveal operation names or schemas that execution would deny.
- Scope notifications by grant or audience and include only protocol-schema revision facts and a fixed reason. Notifications do not carry the catalog, grant identity, tags, or secrets.
- Bind delivery cohorts to opaque server-side grant digests, negotiated protocol sessions, audience partitions, and revision chains; do not model or inspect a consumer cache.
- Accept only exact acknowledgements for the pending revision and affected partition set. Disconnect on grant retirement, fence timed-out sessions, and reject same-session reconnect after a timeout until a fresh protocol session is established.

## Implement one current path

Plan substantial work with `$better-plan` and converge directly on the architecture in the publishing contract. Update requirements, evidence, validation, and architecture before implementation silently changes the target.

Remove superseded registration-lockdown operations, reports, tests, acceptance facts, documentation, and workflow tasks in the same migration. Do not preserve a read-only-console publishing path, a startup-only loader, an unscoped broadcast, or a proxy that cannot consume catalog invalidation as a compatibility branch.

Keep canonical runtime documentation factual while implementation is incomplete. Record the target and open work in the Better Plan artifacts; update public functionality and operating documents in the implementation node that makes each statement true.

## Verify the closed loop

Use two catalog-backed lanes and never conflate their claims:

- `meshrix.upstream-service-prepublication` is the side-effect-free verifier
  for an already-produced report bundle. It validates the template and every
  candidate-bound artifact, then emits a bounded receipt. It must not start a
  service, browser, container, client, upload, authorization, or invocation.
- `meshrix.release-journey` is the side-effecting producer. It creates a fresh
  isolated bundle and must run before every Meshrix.js release candidate; a cached
  receipt never substitutes for this run.

Plan the safe lane first, then run the complete producer with explicit
side-effect admission:

```text
npm run verify:upstream-service-publishing-candidate
npm run verify:upstream-service-publishing-candidate
npm run verify:upstream-service-publishing
npm run verify:upstream-service-publishing
```

The safe lane fails closed when the template or any required artifact is
missing, stale, reordered, dirty-candidate-bound, privacy-unsafe, or
digest-mismatched. Its claim is limited to upstream publishing
prepublication; it cannot emit `functional-complete`, overall `releaseReady`,
or replace the platform acceptance reducer. The full journey remains outside
the tag workflow until the external converter image and adapter bundle have
immutable, owner-published digests. Never restore floating sibling-repository
checkouts as a shortcut.

### Maintain the report template first

Treat the tracked blank report template as the public structural contract and
the generated report as a verified projection. For every report layout,
section, card, table, or content-contract change, complete the maintenance
sequence in this exact order:

1. update this skill and its publishing contract;
2. update the tracked blank template and its deterministic `--check` generator;
3. update the report renderer and focused tests;
4. regenerate the local report only from verified evidence.

For a new mandatory field, first name the verified JSON report and producer that
own the fact and define fail-closed validation in this skill and contract.
The blank-template renderer and verified-report renderer share
`tools/server-scripts/lib/upstream-service-publishing-html.ts`: in step 2 edit
only the shared structural constants and
`renderUpstreamServicePublishingBlankTemplate()`, regenerate and check the
tracked template, then edit the verified-report renderer in step 3.

Run the safe maintenance loop before any side-effecting journey:

```text
npm run generate:upstream-service-report-template
npm run verify:upstream-service-report-template
npm run vitest -- --run \
  tests/vitest/server/upstream-service-publishing-candidate.test.ts \
  tests/vitest/server/upstream-service-publishing-html.test.ts \
  tests/vitest/server/release-journey.test.ts \
  tests/vitest/server/release-workflow-supply-chain.test.ts
npm run generate:upstream-service-publishing-report
npm run verify:upstream-service-publishing-candidate
```

Never hand-edit a generated report. The catalog-backed workflow must validate
the tracked template before either the Core verifier or runtime release
journey. The Core report and candidate receipt tasks must bind their declared
outputs by byte length and SHA-256. The runtime task must bind every mandatory
report output.

Every blank template must remain portable, offline, bilingual, synthetic, and
visibly marked `Not executed / 未执行`. It is neither release evidence nor a
readiness authority and must not contain real screenshots, digests, runtime
values, private paths, or `build/` artifact references.

Every generated HTML report is a single-file portable artifact. Embed every
verified PNG screenshot as a `data:image/png;base64` URL and embed the
downloadable actual publishing JSON as a
`data:application/json;charset=utf-8;base64` URL. Verify each source file's
declared byte length, file signature where applicable, and SHA-256 before
embedding it. Do not leave relative or absolute file references, `blob:` URLs,
external fonts, stylesheets, scripts, images, or network resources in the
HTML. Copying only the HTML file to an otherwise empty directory and opening
it directly must preserve all images, localized text, styles, and downloads.
The original JSON and screenshot files remain the gate-owned evidence inputs;
their embedded copies make the human-readable projection portable and do not
replace those authorities.

Make the successful report an operator manual, not an evidence dashboard.
Keep exactly two ordered top-level sections: `operation-guide` followed by
`appendix`. Begin the main content with the eleven live Console steps in their
verified order. For every step, place its screenshot beside four explicit,
bilingual instructions: where to navigate, what to operate, what the action
produces, and why the step exists. Use human-facing Console menu names and the
stable route; do not substitute verifier internals for operator instructions.

Within `operation-guide`, divide the ordered steps into exactly four bilingual
operator groups without changing their global numbering or evidence order:

1. **Organization structure configuration / 组织架构的配置**: authenticated
   Workbench and published organization/permission projection.
2. **Upstream service registration and publishing / 上游服务的注册到发布**:
   basic descriptor, operation mapping, and publication/runtime health.
3. **Tool permission configuration / 工具权限的配置**: published tool and
   organization-scoped API Key generation.
4. **MCP service request / MCP 服务的请求**: downstream-agent configuration,
   pending approval, completed approval, and final MCP call audit.

Render each group as a semantic subsection with a stable group id, a short
bilingual purpose sentence, a grouped step index, and its own ordered step
cards. The four group headings must be visually stronger than step headings and
must remain understandable in print and narrow viewports.

Move every non-procedural item to the final `appendix`: candidate scope,
execution summary, startup and connector configuration, published interface
catalog, client matrix, golden path, requirements, production boundaries,
revision semantics, protocol delivery, provenance, timings, and cleanup. The
cover may contain only the manual title and one short scope sentence; it must
not front-load readiness metrics, candidate coordinates, timings, or cleanup.
Keep published/runtime health adjacent to the interface catalog inside the
appendix. The client matrix must expose discovery, install, upload, tools/list,
both operation branches, uninstall, and cleanup. Provenance projects only
bounded step IDs, status, duration, and cleanup facts. Every embedded evidence
image uses explicit physical dimensions plus `loading="lazy"` and
`decoding="async"`; print CSS must force deferred content visible.

The success headline is scoped to the upstream publishing journey. It must not
say or imply that Meshrix.js is functionally complete or generally release-ready.
The HTML may project candidate coordinates passed into the renderer, but it
does not own candidate readiness. Generate the external receipt only after the
final HTML bytes exist, so the receipt can bind the HTML without a recursive
HTML-to-receipt digest.

If the journey fails, still write one privacy-safe portable HTML at the
canonical report path. Mark it non-authoritative and failed, include only the
stable failing stage code, bounded step/cleanup status and duration, and fixed
recovery guidance. Do not include the failure message, receipts, logs,
screenshots, configuration download, partial success claim, or runtime data.
The verifier must still exit non-zero; existence of the failure HTML never
promotes evidence.

Capture every live Console checkpoint with a `1440 × 1000` CSS-pixel viewport
and device scale factor `2`, producing a `2880 × 2000` PNG. Record the CSS
viewport, device scale factor, and physical pixel dimensions in the screenshot
manifest. Reject a screenshot whose PNG IHDR dimensions do not match those
facts. Preserve the 2× source bytes when embedding; never satisfy this
requirement by resizing or upscaling a previously captured 1× image.

Every generated report must fill the template's mandatory published-upstream-
interface catalog from the exact publication JSON bytes used by the journey.
Verify those bytes against the journey's byte length and SHA-256 before
rendering. List the health route and every published operation with its
operation key, method and path, approval behavior, request/upload
representation and limits, response/download representation and limits,
byte-range support, scopes, risk, and timeout. Describe an artifact returned
by an operation as that operation's response; never invent a standalone
download endpoint. The catalog must make clear that each listed interface
shape is exercised through the governed Meshrix.js gateway. Missing, blank,
duplicate, stale, or digest-mismatched interface facts fail the report.

The same task runs a self-contained upstream fixture through the real control
plane, manifest loader, gateway snapshot, Operation Permission catalog,
audience projection, downstream protocol connection, and a protocol-owned
neutral peer. It must not load a connector or client implementation.
The separate visual journey must seed the tracked source file through the
authenticated upload-session API with raw `application/octet-stream` chunks,
then pass only an owner-bound `upload:<session-id>:<file-index>` reference to
the downstream MCP tool. It must not use a Base64 JSON file field. The gateway
must resolve that reference and invoke the configured upstream
`artifact_multipart` representation. Request only the dedicated
`meshrix.uploads.write` / `uploads:write` safe-write authority for this data
plane; do not grant the repair-capable Jobs write surface.

The visual journey is also the operator-owned client compatibility matrix.
Seed the exact independently owned adapter packages for the complete supported
catalog: OpenClaw, Codex, Claude Code, Antigravity, OpenCode, Pi, and Kimi CLI.
Discover every target from its real local command. Issue one organization-scoped
API Key through the rendered Console, consume its plaintext only in memory, and
permanently dismiss it before capture. Run each detected target in an isolated
temporary client configuration, install the adapter through the supported
token-environment or token-stdin path, upload the fixture, list the projected tools, invoke both
debug operations through the real connector proxy, uninstall, and remove the
temporary configuration. Every detected target must pass. The report must keep
all seven catalog rows and mark a missing local command `not_detected`; absence
is not fabricated as a pass. If one or more targets are detected, simulation is
forbidden and cannot replace, supplement, or rescue a failed real-client row.

Permit an MCP protocol simulation fallback only when the complete seven-target
scan has finished and every row is `not_detected`. Run one isolated simulated
connector binding through the same upload, tools/list, two-operation, approval,
audit, screenshot, and cleanup path. Mark the validation mode
`simulated-fallback`, record the fixed reason
`no_supported_local_client_detected_after_complete_catalog_scan`, and state
that the result is protocol-path evidence rather than client compatibility
evidence. Never label the simulator as Kimi, Codex, or another detected client
in the matrix. This compatibility matrix and fallback remain separate from the
neutral-peer Core reducer and cannot promote or modify its result.

Publish the same external `POST /v1/convert` operation appearance through two
distinct internal operation keys:

- `convert-require-approval-debug` requires an Operation Permission approval
  receipt and must prove zero successful execution before approval and exactly
  one successful execution after approval for every detected target.
- `convert-full-access-debug` executes without the approval wait, but does not
  bypass the Grant, scope, risk, audience, service, owner, permit, audit, or
  protected-sink checks.

Each real or simulated execution target's discovery bootstrap requests
`meshrix.agentWorkspace.list`. Deliberately omit workspace authority from this
journey Grant and require exactly one `missing_capabilities` denial per execution
target. Report these as expected non-amplification boundary evidence, not as a
failure of either format-convert operation.

Require the report to prove:

- authenticated and unauthorized publishing outcomes;
- injection, path, secret, certificate, and file-permission boundaries;
- new, modified, disabled, rejected, and rolled-back manifest revisions;
- atomic gateway and Operation Permission revision agreement;
- tag-scoped visibility and execution parity;
- scoped list-change delivery, authenticated pull, exact acknowledgement, disconnect, timeout, and reconnect fencing;
- no upstream side effect before authorization or approval;
- redacted audit and report output.

One successful run must converge on these outputs:

- `build/reports/upstream-service-publishing.json` is the recomputable,
  reducer-owned evidence authority.
- `build/reports/release-journey.json` proves the isolated external-service,
  connector, and downstream-agent journey.
- `build/reports/upstream-service-publishing.html` is the offline,
  single-file portable human-readable release report projected only from the
  verified reports, actual publishing JSON, and digest-bound screenshot bytes.
- `docs/examples/upstream-service-publishing-report-template.html` is the
  tracked, portable blank structural template. Its deterministic generator
  must pass `--check` before the runtime journey.
- `build/reports/upstream-service-publishing/upstream-service-basic-config.json`
  is the actual JSON document used for the upstream publication request. The
  HTML must embed its exact verified bytes as a downloadable data URL beside
  the upstream basic-configuration screenshot and display its digest. The
  embedded copy is not a substitute for the gate-owned source file.
- `build/reports/upstream-service-publishing/screenshots/` contains only
  screenshots captured from the running Meshrix.js Web Console.
- `build/reports/upstream-service-publishing-candidate.json` is the bounded
  external receipt that binds one release-definition version and tag, exact
  source commit/tree, Core and journey reports, actual publishing JSON, final
  HTML, and exactly eleven ordered screenshots by repository-relative path, byte
  length, and SHA-256. It carries only the scoped
  `upstream-publishing-prepublication-passed` claim.

The HTML must contain no external scripts or resources, secrets, runtime
payloads, machine identity, private paths, credentials, or raw consumer
configuration. It must contain English and Simplified Chinese copy with a
right-aligned language switch. Exactly one closed inline language controller
is allowed; it may change only declared text nodes, `lang`, and button pressed
state and must perform no network request, storage access, dynamic evaluation,
or HTML injection.
The entire report tree is local-only under Git-ignored `build/`; the gate must
verify that ignore boundary before capture. Do not mask the tracked synthetic
fixture URL, generated service identity, catalog digest, or tool identity.
Continue to protect passwords, issued tokens, authorization codes and request
identities, process fingerprints, cookies, account metadata, execution and
trace identities, private paths, raw client configuration, requests,
responses, documents, logs, shell output, and backend payloads.
It must show the registration-to-invocation route, assertion results,
production boundaries, revision outcomes, protocol cohorts, bounded
provenance, exact safe configuration, and all required screenshots.
The provenance cards must keep sufficient inner padding and wrap long schema
versions and digests inside their borders at desktop and narrow viewports.
The safe configuration must distinguish the external service file-size budget
from the larger per-operation multipart request-envelope `maxBytes`; neither
value may be described as a global Meshrix.js upload limit.

Require the exact isolated startup configuration as selectable report text:

- raw process command `docker compose --profile format-convert up -d`;
- `MESHRIX_BUILD_TARGET=runtime-ui`;
- `MESHRIX_SERVER_WITH_UI=1`.

Require exactly one digest-bound screenshot captured from the running Meshrix.js
Web Console immediately after each distinct visual state, in this order:

1. authenticated Console on the default Workbench with no populated credential
   fields and with account metadata protected;
2. the published Group organization template in organization governance,
   visibly including the organization hierarchy, governed tags, and
   administrator-role projection;
3. upstream service basic descriptor loaded in the Console editor;
4. upstream operation and payload mapping loaded in the Console editor, visibly
   including the imported `artifact_multipart` request representation and its
   configured multipart request `maxBytes`; never capture an empty manual
   operation form or placeholder defaults for this evidence;
5. service publication and runtime health success in the Console;
6. the published operation visible in the Console tool catalog;
7. the issued organization-scoped API Key record in the Key Distribution page,
   captured only after the one-time secret has been permanently dismissed;
   protect credential and workload identifiers and never capture the issued
   plaintext key;
8. the privacy-safe downstream-agent configuration guidance after the real
   connector has been configured with the pre-issued API Key through the
   token-environment or token-stdin path; show placeholders only, never raw
   configuration, local paths, runtime identity, or the key;
9. the pending `convert-require-approval-debug` operations in the Console
   approval flow, exactly one for each detected client, with protected
   identities masked;
10. the same operations completed after Console approval, with protected
   identities masked;
11. the successful downstream MCP tool invocation matrix visible in the Console
   recent-call audit, with execution and trace identities masked.

The report must also list the safe downstream connector configuration:
transport kind, the complete seven-target catalog, detected status, adapter
coordinate, requested toolsets, requested scopes, maximum risk, both published
capabilities, allowed service, installation, upload, tools/list, both debug
calls, and cleanup status. It must never include the issued token, token path,
process identity, private URL, private path, client command path, or raw client
configuration.
The client acceptance matrix first column must contain only one human-readable
client label per row. Do not repeat the target id below the label.

A missing, duplicate, blank, stale, reordered, digest-mismatched, or
privacy-unsafe screenshot fails the entire pre-release closure. Never replace a
live product page with a manually assembled page, receipt card, DOM-only
snapshot, mock Console, or screenshot of generated status text. Do not
assemble the HTML manually or treat it as a second readiness authority. A
successful protocol receipt without the corresponding required Console
screenshot is insufficient.

Run this targeted closure first, then the canonical platform acceptance
reducer. The paired capability reports provide mandatory scoped evidence, but
only the platform reducer may declare the Meshrix.js functional release accepted.
