# Enterprise Recording Policy Contract

> Contract source: `packages/contracts/src/recording/`
> (`@meshrix/contracts/recording`, plus the `./recording/policy` and
> `./recording/lifecycle` subpath exports). Neutral corpus:
> `packages/contracts/src/fixtures/recording-corpus.json`.

This document describes the versioned enterprise recording contract: the
`RecordingPolicy` that selects optional recording categories, the
`RecordingSink` descriptor, the `RecordAdmission` gate decision at each
collection point, the per-category `RecordingRecord` envelopes and the
truthful post-effect `RecordingOutcome` reports.

This file owns protocol shape and semantics. The durable sink
implementation (`NODE-RECORDING-SINK`), producer/consumer wiring
(`NODE-RECORDING-PRODUCERS`), console surface (`NODE-RECORDING-CONSOLE`) and
final enterprise profile composition (`NODE-ENTERPRISE-PROFILE`) are separate
deliveries that consume these schemas rather than redefining them.

## Schema versions

| Surface | Constant | Value |
| --- | --- | --- |
| Policy schema | `RECORDING_POLICY_SCHEMA_VERSION` | `v0.0.1:recording:policy-1` |
| Lifecycle schema | `RECORDING_LIFECYCLE_SCHEMA_VERSION` | `v0.0.1:recording:lifecycle-1` |
| Corpus schema | `recording-corpus.json.schemaVersion` | `v0.0.1:recording:corpus-1` |

All messages are strict exact-key JSON objects. Unknown, missing, extra or
misplaced fields are rejected (`parseObject` requires the declared key set,
nothing more and nothing less). Protocol revisions must bump the version
constants and extend the neutral corpus.

## Selected history versus minimal correctness state

The contract governs *selected histories* only. Every lifecycle message
declares `evidenceClass: "selected_history"` and is gated by the current
`RecordingPolicy` revision. Two other evidence classes exist and are never
routed through this contract:

- `minimal_correctness` — the operational state that authorizes and recovers
  operations. `RECORDING_MINIMAL_CORRECTNESS_STATE` inventories the real
  fields and lifetimes at their actual owners: grant/revocation revisions and
  replay fences/execution intents in `gateway-continuation-ledger`, and
  unknown-outcome reconciliation in the permit authority. These items are not
  recording categories, and history rows may never borrow their names to
  survive a disabled category (`recordingCategoryIsOperationalState` returns
  `false` for every category; `RECORDING_HISTORY_IS_OPERATIONAL_STATE ===
  false`).
- `required_evidence` — the mandatory compact lifecycle proof owned by
  `operation-audit-projection` (`RECORDING_REQUIRED_EVIDENCE`). It exists for
  the configured objective regardless of any recording selection and is never
  enabled, disabled or relabelled by this contract.

`RECORDING_BLANKET_HISTORY_REQUIRED === false`: enabling categories is an
enterprise policy choice, not a precondition of correctness.

## Categories and obligations

`RECORDING_CATEGORIES` are independently selectable; a category is enabled
exactly when it appears as a key in the policy `categories` map:

| Category | Content | Notes |
| --- | --- | --- |
| `content` | Approved request/response/tool-result fields and artifacts | Must name `fieldAllow`; records carry `contentDigest` + `artifactRefs` custody only, never bytes; the only category with a nonzero `maxContentBytes` retention budget |
| `governance_history` | Bounded governance events (`RECORDING_GOVERNANCE_EVENTS`) referencing canonical `decisionRef`/`authorityRefs` | Optional retention projection; authorization state stays at its owners |
| `execution_history` | `started`/`completed`/`failed` events with `effectClass` and `durationBucket` | `started` requires `durationBucket: "not_applicable"`; the only categories eligible for `required_before_effect` with `governance_history` |
| `usage` | Aggregated counters over a `bucketStart` window | `fieldAllow` names the permitted counter fields |
| `diagnostics` | Bounded local diagnostic events | `eventAllow` names the permitted `eventCode` values |

`RECORDING_OBLIGATIONS` are `optional` or `required_before_effect`. Only
`execution_history` and `governance_history`
(`RECORDING_REQUIRED_OBLIGATION_CATEGORIES`) may carry the required
obligation, and only those categories may own a `pre_effect` collection
point — a `pre_effect` admission or record for any other category fails
validation. `content`, `usage` and `diagnostics` are always optional.

Each category selection declares `sinkRef`, `fieldAllow`, `fieldRedact`,
`eventAllow`, `readerRoles`, `configurerRoles`, a `retention` budget
(`maxAgeSeconds`, `maxRecords`, `maxContentBytes`, `maxIndexBytes`) and a
`capacity` budget (`maxBufferedRecords`, `maxRecordBytes`), all bounded by
`RECORDING_POLICY_LIMITS`.

## Privacy boundary

`RECORDING_FORBIDDEN_KEYS` is enforced inside parsing
(`containsForbiddenRecordingKeys`), so a policy, admission, record or outcome
that smuggles credentials, private keys, permits, secrets, tokens or raw
payload material (`payload`, `request`, `response`, `result`, `prompt`,
`headers`, `plaintext`, `stack`…) fails before dispatch.
`RECORDING_RECORDS_MAY_HOLD_SECRETS === false` and
`RECORDING_MAY_STORE_REUSABLE_PERMIT === false`; `assertRecordingCorePrivacy`
throws on violation. Records carry digests and artifact references only —
selected content bytes never appear as record fields, so an "operational"
record can never smuggle retained history.

## Policy revisions

`parseRecordingPolicy` validates one versioned `recording-policy` document.
`assertRecordingPolicyChange(current, next, configurerRole)` publishes a new
revision atomically: the `policyId` is immutable, `policyRevision` must
strictly increase, and the actor must hold a configurer role on the *current*
revision. `recordingRoleAuthorized` keeps role authority per category and per
access kind (`read`/`configure`) — no wildcard roles.

Off wins at every collection point:

- `RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT === false` — enabling a category
  applies only to future collection points; nothing is backfilled.
- `RECORDING_OFF_DELETES_CAPTURED_RECORDS === false` — off stops capture; it
  never retroactively deletes records already written (retention owns
  deletion).
- `RECORDING_ADMITTED_REVISION_OVERRIDES_OFF === false` — a record carries
  the `policyRevision` it was admitted under
  (`recordingRecordCapturedUnderPolicy`), and a stale admitted revision never
  re-enables a category the newer revision disabled.
- `recordingSettlementMayContinue` still lets already-captured records finish
  legitimate settlement under the current policy.

## RecordingSink

`parseRecordingSink` describes the single durable destination class:
`custody: "enterprise_local"`, `durable: true`
(`RECORDING_SINK_REQUIRES_DURABLE === true`), and budgets
(`maxRecordBytes`, `maxContentBytes`, `maxIndexBytes`,
`maxBufferedRecords`, `maxPendingWrites`). A volatile or hosted-custody sink
fails validation — it would falsify `recorded` outcomes.
`parseRecordingSinkState` is the live capacity view reported at admission
time; content bytes and index/metadata bytes are separate pools.

## RecordAdmission gate

`admitRecordingCategory` is the canonical gate every producer consults before
serializing or enqueueing. Evaluation order is contractual: policy selection
and privacy first, then role, then sink availability/capacity.

- `deny` — `category_disabled`, `policy_superseded`, `role_unauthorized`,
  `forbidden_field`, `field_not_selected`, `phase_mismatch` or
  `destination_unselected`. A disabled category denies before any collection
  (`assertRecordingDisabledCollectsNothing`): no serialization, enqueue,
  write or incidental telemetry copy.
- `shed` — `capacity_exceeded`, `rate_limited` or `sink_unavailable`;
  optional categories only. `RECORDING_OPTIONAL_SHED_STOPS_WORK === false`:
  shed records never block healthy upstream work.
- `reject` — `recording_unavailable` only, and only when a
  `required_before_effect` start record cannot be reserved at `pre_effect`.
  `recordingAdmissionBlocksOperation` returns `true` solely for `reject`:
  required-state admission precedes protected dispatch, but the failure is a
  refused operation, not an unrecorded one.
- `admit` — reserved capacity under the current revision.

## RecordingOutcome honesty

`parseRecordingOutcome` enforces truthful post-effect reporting per category.
`RECORDING_FAILURE_UNDOES_EFFECT === false` and
`RECORDING_RECONCILE_REPLAYS_EFFECT === false`: a sink failure after an
external effect can never undo the effect, and reconciliation rewrites only
missing recording — `recordingMayReplayEffect` always returns `false`.

- `recorded` — requires `recordsWritten >= 1`, no failure, `pendingTerminal:
  false`.
- `partially_recorded` — some records written plus a typed reason or failure
  (e.g. the category was disabled mid-operation).
- `shed` — optional only, with a capacity/availability reason.
- `not_recorded` — zero writes; a `required_before_effect` obligation must
  keep `pendingTerminal: true` so the owed terminal record stays visible
  (`RECORDING_FULL_STORE_GUARANTEES_TERMINAL_AUDIT === false`) — see
  `recordingObligationOutstanding`.
- `recording_degraded` — sink unavailable or write failed; the operation
  keeps its real status and can never be reported `not_started` after a
  post-effect or settlement failure.
- `terminal_record_pending` — a required terminal record could not be
  durably captured; never claimed while pending.

`operationStatus` uses `RECORDING_OPERATION_STATES` (`not_started`,
`in_progress`, `succeeded`, `failed`, `cancelled`, `in_doubt`,
`status_unavailable`) mirrored from the continuation-ledger honesty rules:
a lost acknowledgement never rewrites a dispatched operation as
`not_started`, and an effect that may have happened is reported `in_doubt`
or `status_unavailable`, not success. `recordingOutcomeFor` derives the
canonical outcome tuple from obligation, enablement, written counts, owed
terminal records, admission shed and typed `RecordingFailure`; it returns
`null` for impossible combinations rather than producing a dishonest report.

## Neutral corpus

`recording-corpus.json` holds synthetic valid and invalid exemplars:
three policies (empty selection, required-execution-only, all categories),
every lifecycle kind (`recording-sink`, `record-admission`,
`recording-record`, `recording-outcome`) and named sink/policy state views.
Invalid cases cover wrong schema version, extra/missing keys, unknown
category, forbidden-key smuggling, empty allowlists and role lists,
non-advancing/zero revisions, invalid obligation–category and phase–category
pairings, records carrying payload/secret keys, non-content records carrying
content bytes, content records without artifact custody, shed-on-required and
reject-optional admission pairings, dishonest outcomes (recorded with zero
writes, terminal-owed claimed met, post-effect failure claiming
`not_started`), and non-durable or hosted-custody sinks. All fixtures are
neutral — no real credentials, secrets, plaintext or machine-private paths.

The focused suite `tests/vitest/contracts/recording-contract.test.ts`
(registry id `contracts.enterprise-recording`) enforces frozen constants,
exact-key parsing, corpus-wide accept/reject, admission ordering and
blocking rules, per-category role independence, atomic revision publication,
off-wins semantics, and outcome honesty.

## Ownership

| Concern | Owner |
| --- | --- |
| Policy/lifecycle schemas, corpus, admission gate, outcome derivation | `NODE-RECORDING-CONTRACT` (`packages/contracts/src/recording/`) |
| Durable sink, retention enforcement, bounded capacity, reader/export, restart behavior | `NODE-RECORDING-SINK` |
| Producer/consumer wiring of dispatch, proof and audit collection points | `NODE-RECORDING-PRODUCERS` |
| Console policy surface | `NODE-RECORDING-CONSOLE` |
| Enterprise profile composition/configuration | `NODE-ENTERPRISE-PROFILE` |
| Minimal correctness state and lifecycle proof | Existing owners (`gateway-continuation-ledger`, `operation-audit-projection`, permit authority) — unchanged |

This is a contract/design-phase delivery: no deployment, publication or
hosted-identity claim, and no runtime producer or sink implementation is
asserted by this document.
