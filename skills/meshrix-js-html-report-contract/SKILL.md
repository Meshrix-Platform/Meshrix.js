---
name: meshrix-js-html-report-contract
description: Maintain the portable single-file HTML report for the Meshrix.js upstream service publishing journey — blank template, renderer, digest-bound screenshots, interface catalog, operation evidence, and privacy constraints. Use for report layout, template, renderer, screenshot, or content-contract changes. The verification lanes are owned by $meshrix-js-release-journey-producer; the client compatibility matrix by $meshrix-js-client-compatibility-matrix.
---

# Meshrix.js HTML Report Contract

This skill owns the **portable HTML report contract** of the upstream service
publishing journey: the tracked blank template, the shared renderer, the
digest-bound screenshots, the interface catalog, the operation evidence, and
the privacy constraints. The verification lanes and candidate receipt belong
to `$meshrix-js-release-journey-producer`; the downstream client compatibility
matrix belongs to `$meshrix-js-client-compatibility-matrix`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Read [references/publishing-contract.md](../../meshrix-js-upstream-service-publishing/references/publishing-contract.md) completely when changing the capability flow, state model, security boundary, event contract, protocol delivery, server gate, or report contract.
3. Keep the report contract separate from the verification lanes: this skill owns the template, renderer, screenshots, and content contract; `$meshrix-js-release-journey-producer` owns the two verification lanes and the receipt.

## Maintain the report template first

Treat the tracked blank report template as the public structural contract and
the generated report as a verified projection. For every report layout,
section, card, table, or content-contract change, complete the maintenance
sequence in this exact order:

1. update this skill and the publishing contract;
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

## HTML report contract

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

## Screenshot contract

Capture every live Console checkpoint with a `1440 × 1000` CSS-pixel viewport
and device scale factor `2`, producing a `2880 × 2000` PNG. Record the CSS
viewport, device scale factor, and physical pixel dimensions in the screenshot
manifest. Reject a screenshot whose PNG IHDR dimensions do not match those
facts. Preserve the 2× source bytes when embedding; never satisfy this
requirement by resizing or upscaling a previously captured 1× image.

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

A missing, duplicate, blank, stale, reordered, digest-mismatched, or
privacy-unsafe screenshot fails the entire pre-release closure. Never replace a
live product page with a manually assembled page, receipt card, DOM-only
snapshot, mock Console, or screenshot of generated status text. Do not
assemble the HTML manually or treat it as a second readiness authority. A
successful protocol receipt without the corresponding required Console
screenshot is insufficient.

## Interface catalog and evidence

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

## Operation evidence

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

## Privacy and startup configuration

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
