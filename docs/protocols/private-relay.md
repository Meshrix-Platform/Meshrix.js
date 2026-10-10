# Private Relay Wire Protocol

> Contract source: `packages/contracts/src/private-relay/`
> (`@meshrix/contracts/private-relay`, plus the `./session` and `./recovery`
> subpath exports). Neutral wire corpus:
> `packages/contracts/src/fixtures/private-relay-wire-corpus.json`.

This document describes the versioned wire contract between an installed entry
product, a user-controlled receiving gateway (endpoint), and the Workers-native
opaque relay. The relay forwards ciphertext and opaque routing metadata only;
trust, semantics and plaintext live exclusively at the endpoints.

This file owns protocol shape and semantics. Runtime implementations (Workerd
relay, endpoint gateway, installed entry) are separate deliveries and consume
these schemas rather than redefining them. The actual Workerd relay's
build/check/deploy boundary, privacy projection, operational error taxonomy
and cost honesty live in
[Private Relay Operations](private-relay-operations.md).

## Schema versions

| Surface | Constant | Value |
| --- | --- | --- |
| Session/admission wire | `PRIVATE_RELAY_SCHEMA_VERSION` | `v0.0.1:private-relay:wire-1` |
| Recovery/vault wire | `PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION` | `v0.0.1:private-relay:recovery-1` |
| Peer mailbox wire | `PRIVATE_RELAY_PEER_SCHEMA_VERSION` | `v0.0.1:private-relay:peer-1` |
| Wire protocol tag | `PRIVATE_RELAY_WIRE_PROTOCOL` | `meshrix-private-relay/0` |

All messages are strict exact-key JSON objects. Unknown, missing, extra or
misplaced fields are rejected. Protocol revisions must bump the version
constants and extend the neutral corpus.

## Roles, modes and purposes

- Roles: `entry` (installed client), `endpoint` (receiving gateway).
- Modes: `personal`, `enterprise`. A session open whose admission mode does not
  match the enrolled mode is rejected; there is no inferred or fallback mode.
- Session purposes: `forward` (normal opaque forwarding) and `recover_device`
  (recovery channel; admits only recovery message kinds plus
  `session-close`/`session-reconnect` — see `recoveryChannelAdmitsOnlyRecovery`).

## Privacy boundary

`RelayAdmissionBinding` carries exactly:

- opaque `tenantId`, `deviceId`, `routeId`
- `role`, `mode`
- `admissionGeneration`, `revocationRevision`

It carries no semantic tool grants, catalog names, upstream identities,
credentials or product names. `PRIVATE_RELAY_FORBIDDEN_KEYS` is enforced inside
parsing (`containsForbiddenRelayKeys`), so a message that smuggles semantic
material fails before dispatch. Trust never derives from a product name or a
relay-selected key.

Frame `payload` is opaque base64url ciphertext. The relay cannot and must not
interpret it. `frame-ack` acknowledges transport receipt only —
`PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF === false`; acknowledgement is never
evidence of endpoint execution or consumption.

## Session lifecycle

Canonical states (`PRIVATE_RELAY_SESSION_STATES`) and events:

```
initiated --open--> open_sent --admit--> admitted --frame--> streaming
   |                  |                                 |
   |                  +--reject--> rejected             +--close--> closing
   v                                                       |--close_complete--> closed
 closing (on close from any open state)                        |--reconnect--> reconnecting
                                                               reconnecting --restore--> admitted
                                                               reconnecting --reject--> rejected
```

`relaySessionTransition(state, event)` is the single canonical table; unknown
transitions return `null`, and `assertRelaySessionTransition` throws
`PRIVATE_RELAY_SESSION_TRANSITION_REJECTED`.

- `session-admitted` carries the route `cursors` alongside the relay limits.
  Route sequence cursors outlive individual sessions: a fresh session that
  restarted outbound numbering at `1` would be indistinguishable from a replay
  and silently dropped while the route cursor survives, so senders continue
  their direction's numbering from the reported cursor (`toEndpoint` for the
  entry role, `toEntry` for the endpoint role).
- `session-reconnect` re-presents the full `RelayAdmissionBinding` plus
  `lastAcknowledged` sequence cursors and `reconnectGeneration`. Reconnect
  always re-checks current authorization and revocation revision; revocation is
  local-immediate and becomes remote only after authenticated delivery or
  reconnect — no immediate-revocation claims on unreachable devices.
- `session-restored` reports `gaps` with typed causes
  (`PRIVATE_RELAY_GAP_CAUSES`, e.g. `expired`) and never invents an
  "unknown" global cause. This is the hibernation-safe restoration path.
- `session-close` carries a `PRIVATE_RELAY_CLOSE_REASONS` reason and final
  sequence cursors.

## Flow control and endpoint reachability

`PRIVATE_RELAY_LIMITS` bounds frame payload (256 KiB), outstanding bytes
(4 MiB), buffered frames (256) and message rate (128/s). `flow-credit` grants
budget; `admitOutboundFrame`/`acknowledgeFrames` implement the accounting and
return `null` on over-limit admission or ack mismatch — the contract for
slow-reader backpressure.

The relay forwards each `frame` verbatim, so the delivered `sessionId` is the
*sender's* live session. A peer reconnect replaces it: receivers bind the
pinned inner channel to the inbound peer session and rebuild it on change —
bytes queued under the dead session are dropped rather than fed into the fresh
TLS record stream. On the entry side, a `route-status` transition to
`unreachable` tears the dead channel down and the next `reachable` notice
re-handshakes onto the endpoint's new session generation.

Endpoint availability is decided at admission time:

- `endpointReachabilityForNewWork` returns `reachable` or
  `endpoint_unreachable`. A new call against an unreachable endpoint fails
  immediately — `PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES === false`.
- Work already submitted before a disconnect is never reclassified as
  unexecuted. A lost acknowledgement is not evidence that work never started;
  `assertOfflineCallHandling` routes it to `operation_status_query_required`.

## Recovery authority and encrypted snapshots

The recovery wire (`private-relay-recovery.ts`) separates three proof purposes
(`PRIVATE_RELAY_PROOF_PURPOSES`): `recover_device`, `vault_fetch`,
`vault_write`. `assertRecoveryPurposeSeparation` rejects cross-purpose proofs.

- `recovery-request` → `recovery-challenge` (single-use, expiring nonce;
  `singleUse: true`, `expiresAt > issuedAt` enforced) → `recovery-proof` →
  `recovery-result` (`enrolled` with a device admission that requires mutual
  TLS rebind, or `refused` with a typed `PRIVATE_RELAY_RECOVERY_REFUSALS`
  reason). Fresh-device proof does not depend on an old device cookie or
  certificate.
- `EncryptedRecoverySnapshot` is a versioned AEAD envelope
  (`AES-256-GCM`/`XChaCha20-Poly1305`), an opaque vault locator, generation and
  revision, plus a public verifier. `PRIVATE_RELAY_SNAPSHOT_MAY_HOLD_PLAINTEXT
  === false`; the vault stores ciphertext and public verification material
  only (`assertSnapshotServiceVisibility`).
- `vault-write` is a bounded compare-and-swap: `expectedRevision` +
  `writeAuth` (writer key, fresh nonce, `sha256:` snapshot digest, signature).
  `vault-write-result` reports `committed`/`conflict`/`refused`;
  `vaultWriteCommitted` requires the committed revision to advance past the
  expected revision — a replayed or stale write cannot fabricate a commit.
- Recovery-key rotation is staged and per-endpoint:
  `staged → published → acknowledging → completed | aborted`
  (`rotationTransition`). `rotation-state` records acknowledged/pending
  endpoint sets and `globalComplete` is pinned to `false`
  (`assertRotationNotGlobal`) — no atomic global rotation claims while
  endpoints remain pending, and a vault snapshot can never reduce the current
  revocation state.

## Operation status (GatewayOperationRecovery)

`operation-query` is bound to the original principal and generation.
`operation-status` reports `PRIVATE_RELAY_OPERATION_STATES`:

- `not_started` — only with typed `PRIVATE_RELAY_NOT_STARTED_EVIDENCE`
  (`local_never_submitted` or `endpoint_refused_pre_dispatch`). A lost
  acknowledgement can never produce `not_started`.
- `dispatched_in_doubt`, `in_progress`, `status_unavailable` — explicit
  unknown outcomes; `operationRetryPermitted` allows retry only for
  `not_started`, and `PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED === false`.
- `completed` (result `available`), `completed_result_unavailable`,
  `failed`, `cancel_intent_recorded` — terminal/intermediate honest states;
  the schema rejects `completed` paired with an unavailable result.

Endpoint trust bindings (`endpoint-trust-binding`) pin the paired identity
key/fingerprint, mode, role, trust generation, principal reference and a
capability grant reference. They travel only inside the authenticated inner
channel or approved endpoint storage and are never copied into relay
admission or telemetry.

## Peer messaging mailbox

The peer wire (`private-relay-peer.ts`, schema `v0.0.1:private-relay:peer-1`)
adds reliable one-to-one agent messaging: a per-recipient mailbox partition
that stores only Signal-family ciphertext envelopes, durable positions and
typed receipts. One device pairs with exactly one peer on its route; the
mailbox runtime re-checks the same directory admission authority session
sockets use, and request messages carry `tenantId`/`routeId`/`deviceId` only
so that authority can bind them — the wire itself never selects a tenant or a
route, and a `targetTenantId`-style steering field fails exact-key parsing.

Wire kinds (`PRIVATE_RELAY_PEER_KINDS`):

| Kind | Direction | Semantics |
| --- | --- | --- |
| `peer-bundle-publish` → `peer-bundle-published` | device → mailbox → device | Publish the device's Signal prekey bundle (`format` from `PRIVATE_RELAY_PEER_SIGNAL_PROFILES`, `bundleId`, monotonic `revision`, opaque public `material`). Response reports `published`/`superseded`/`refused` with a typed `PRIVATE_RELAY_PEER_REFUSALS` reason. |
| `peer-bundle-fetch` → `peer-bundle` | device → mailbox → device | Fetch the paired peer's current bundle. Response reports `available` + bundle, `unpublished` (honest absence), or `refused` + typed refusal. |
| `peer-send` → `peer-accepted` | sender → mailbox → sender | Enqueue an encrypted envelope into the recipient partition. Response reports `accepted`/`duplicate`/`conflict` plus the durable `position`; accepted/duplicate carries the `accepted` receipt, conflict carries none. |
| `peer-fetch` → `peer-messages` | recipient → mailbox → recipient | Cursor page (`afterSeq`, bounded `limit`) returning stored messages in strictly ascending position order, `nextAfterSeq` resume cursor, `more` continuation flag and `gaps` tombstones. |
| `peer-ack` → `peer-acked` | recipient → mailbox → recipient | Idempotently record `received` acknowledgements plus optional application-level `reports`. Response returns `recorded` receipts and `refused` entries with `PRIVATE_RELAY_PEER_ACK_REFUSALS`; `peerAckFullyRecorded` requires every requested id to be recorded or explicitly refused — never silently dropped or invented. |
| `peer-receipt` → `peer-status` | sender → mailbox → sender | Query receipt status for sender-scoped `messageIds`. Each status reports `position` (`0` = unknown, never inventing receipts) plus the recorded receipt list. |
| `peer-retention-policy` | mailbox → device | Enrollment-time advertisement of the deployment-selected finite `mailboxCapacityBytes`, `mailboxRetentionMs` and `mailboxMaxItems`. Shape only — runtime enforcement and cleanup scheduling belong to the mailbox delivery. |

The `PeerEnvelope` is `format` + `headers` + `ciphertext`. Headers carry only
session metadata the peer crypto layer owns — `messageType`
(`prekey`/`session`), sender/recipient bundle ids and nullable prekey
references — so the mailbox can route and store without ever reading
plaintext. `PRIVATE_RELAY_PEER_MAILBOX_SEES_PLAINTEXT === false` and
`containsForbiddenPeerKeys` reject a message carrying `grants`, `plaintext`,
tool names, credentials or agent-intent fields at any nesting depth
(`assertPeerEnvelopeCipherOnly`).

Sender-scoped `messageId` is the deduplication key within
(tenant, route, sender, recipient): a resend with identical envelope bytes is
an idempotent `retry` answered by the stored `accepted` receipt (`duplicate`
outcome); the same id with different bytes is a typed `conflict`
(`peerSendReplayClass`). The stored first write decides the binding — a send
cannot smuggle a body digest or a conflict-resolution field to overwrite it.

Receipt taxonomy (`PRIVATE_RELAY_PEER_RECEIPT_KINDS`):

- `accepted` — issued by the mailbox (`source: "mailbox"`) when the envelope
  is durably stored.
- `received` — issued by the authenticated recipient (`source: "recipient"`)
  when its inbox entry is durably recorded.
- `accepted_by_agent`, `completed`, `rejected` — independent application
  reports (`source: "agent"`) submitted through `peer-ack` `reports`. They are
  never inferred from mailbox acknowledgements:
  `PRIVATE_RELAY_PEER_APP_RECEIPTS_FROM_ACKS === false`, and the parser pins
  each kind to its only honest source. A mailbox `accepted` or a recipient
  `received` says nothing about agent execution — delivery acknowledgement is
  not consumption evidence, mirroring
  `PRIVATE_RELAY_ACK_IS_CONSUMPTION_PROOF === false`.

Retention is deployment-selected and explicit (no invented default):
expiry or capacity truncation removes envelopes but produces observable
`gaps` tombstones — `{fromSeq, toSeq, cause, messageIds}` with typed
`PRIVATE_RELAY_PEER_GAP_CAUSES` (`expired`, `capacity_truncated`) — so a
cursor never silently advances past lost messages, and a sender can still
reconcile the lost `messageIds` through `peer-status` (position `0`, empty
receipts). A disconnected receiver resumes from `afterSeq` plus its
unacknowledged ids; unknown delivery state stays explicit.

### Mailbox runtime behavior (`NODE-MAILBOX-RUNTIME`)

The Workerd runtime implements this wire inside
`workers/private-relay` as `MailboxDO` — one SQLite-backed Durable Object
per `(tenantId, routeId, deviceId)` recipient partition. Peer kinds travel
as request/response on the same admitted `forward`-purpose session socket
the frame channel uses; they are never forwarded peer-to-peer and never
admitted on a `recover_device` channel. The session object binds each
request to the credential-authenticated identity (a `tenantId`/`routeId`/
`deviceId` mismatch is a protocol error) and stamps the live
`revocationRevision`/`admissionGeneration`; the partition re-validates the
binding and resolves the route pairing through the tenant directory, the
same admission authority the session uses — revocation is pushed to live
sockets *and* to partitions, so a revoked owner answers honestly where the
wire carries a refusal (`peer-bundle-published`/`peer-bundle`/`peer-acked`
`refused`) and drops where it cannot (`peer-send`/`peer-fetch` have no
refusal outcome; the revoked device's socket is already closed by the
authority path).

- `peer-send` routes to the `peerDeviceId` partition; `peer-fetch`/
  `peer-ack`/`peer-bundle-publish` hit the caller's own; `peer-bundle-fetch`
  hits the named peer's; `peer-receipt` resolves the paired peer through
  the directory. Position is a per-partition monotonic counter, commits are
  transactional, and cursor reads are indexed range scans on position.
- A committed send pushes the next `peer-messages` page to the recipient's
  live socket (event-driven wakeup); `peer-fetch` pull remains the
  supported fallback.
- `peer-retention-policy` is pushed on session admission and re-served on
  pull; the values come from `RELAY_MAILBOX_CAPACITY_BYTES`,
  `RELAY_MAILBOX_RETENTION_MS` and `RELAY_MAILBOX_MAX_ITEMS` (clamped to
  `PRIVATE_RELAY_PEER_LIMITS`), never an invented default.
- Expiry runs on one scheduled alarm while data exists; capacity evicts
  the oldest envelopes at send time. Both write tombstones; `peer-status`
  reconciles truncated ids as position `0` with empty receipts.

### Product surfaces (`NODE-PEER-INTEGRATION`)

`PeerClient` (`packages/peer-client`) is the embedded runtime on both ends
of a route. It owns durable file stores — Signal crypto state, the durable
outbox, the deduplicated inbox with its committed cursor, pending
application reports and learned retention-gap tombstones — under a
caller-chosen state directory, and it speaks only the peer-schema kinds on
the caller-supplied session channel.

`createPeerSessionChannel` (`packages/entry-transport/peer-channel.ts`)
binds that client to the **same** admitted `forward` session the frame
channel rides: outbound peer requests are gated on session admission and
raise the typed `peer_channel_not_admitted` error instead of silently
entering a stale generation. `isPeerSchemaMessage` lets each product demux
peer kinds to `PeerClient.handleInboundMessage` before its session driver
interprets frame/recovery traffic, so no second connection exists.
`peerIdForRouteDevice` derives the deterministic crypto identity
`peer:<tenantId>:<routeId>:<deviceId>`; `routePeerDirectory` resolves the
same id for a counterparty device, so safety numbers are always computed
from pinned identities and route bindings — never from wire-supplied ids.

- **Endpoint** (`private-endpoint` profile, opt-in `peer` config block):
  `EndpointPeerRuntime` stores state under `peer.storageDir` (default
  `<configDir>/peer-state`, owner-only) and exposes the loopback admin
  routes `/peer/status`, `/peer/inbox`, `/peer/pair-safety`,
  `/peer/send`, `/peer/ack-outcome`, `/peer/reconcile` and `/peer/sync`.
  When the block is absent or disabled the routes answer `404
  peer_disabled` and no peer traffic is emitted or accepted.
- **Entry product** (`@meshrix/entry-gui`): `EntryPeerRuntime` keeps a
  per-connection store at `<dataDir>/peer/<connectionId>/`, exposed
  through the closed IPC op set `peer.status`, `peer.send`, `peer.inbox`,
  `peer.sync`, `peer.ackOutcome` and `peer.pairSafety`. Revoking or
  uninstalling a connection deletes only that connection's peer store.

Both runtimes are **record-only**: inbound messages are durably recorded
and surfaced, never executed. Application outcomes travel only through the
explicit `peer-ack` `reports` field (`accepted_by_agent` / `completed` /
`rejected`), submitted by a host that actually consumed the message; the
peer layer itself never fabricates an application receipt, never upgrades
a mailbox `accepted`/`received` into one, and reports undecryptable
envelopes as stored `decryptError` evidence rather than plaintext guesses.

Explicit boundary of this integration: no agent execution of peer content,
no group or fan-out messaging, and no bundled host dispatch — a host
integration remains a separately authorized, explicitly injected handler.

## Neutral wire corpus

`private-relay-wire-corpus.json` holds synthetic valid and invalid exemplars
covering every message kind plus: semantic material smuggled into admission or
frames, product-name trust, wrong mode, zero generation, padded/non-canonical
payloads, invented reject reasons, inverted or unknown-cause gaps, cross-purpose
proofs, reusable/expired challenges, missing CAS fields, snapshots carrying
configuration or secrets, lost-ack-as-not-started, completed-without-result,
global-complete rotation claims, generation regressions, unknown trust modes,
and short nonces. The `peer` section covers every mailbox kind plus hostile
shapes: cross-tenant steering fields, a replayed messageId carrying a smuggled
body-digest claim, envelopes smuggling `grants`/`plaintext`, invented or
mailbox-derived receipt kinds, self-addressed sends, negative sequence
cursors, oversized fields, non-monotonic pages, empty ack batches, and
zero-valued retention. All fixtures are neutral — no real credentials,
plaintext, or machine-private data.

The focused suite `tests/vitest/contracts/private-relay-contract.test.ts`
(registry id `contracts.private-relay-wire`) enforces exact-key parsing,
peer agreement on valid messages, rejection of every invalid case, the session
and rotation state machines, reachability/retry honesty, bounded frame
accounting, and snapshot visibility. For the peer wire it additionally pins
the receipt taxonomy, sender-scoped idempotency/conflict, ack coverage
honesty and the ciphertext-only envelope boundary.

## Endpoint operator profile

`apps/mcp-gateway-installer` ships the runnable endpoint side of this wire as
`meshrix-gateway private-endpoint serve --config FILE` (with `private-endpoint
check` for offline validation). The profile composes the existing governed
gateway with `createPrivateGatewayEndpoint` over a real `wss:` WebSocket
transport (`ws:` only for literal loopback fixtures) and supervises the session
lifecycle the contract requires:

- The endpoint state surface reports `reachable` only for a live admitted
  session; otherwise new work receives `endpoint_unreachable` and nothing is
  queued for later execution (`PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES ===
  false`).
- Reconnects preserve session cursors through `session-reconnect`; a
  retryable `session-rejected` is re-presented with the relay-expected
  revocation revision on a fresh session driver, and non-retryable rejections,
  `revoked` closes and protocol failures end the run with a typed outcome.
- Operator-visible revocation and recovery-authority state distinguishes
  locally staged changes from relay-acknowledged ones (`pending` until the
  admission revision catches up — never "applied" off local staging).
- Endpoint administration is not published through the relay: state and
  control are served only on an optional loopback listener or inside the
  pinned inner channel. Credentials, inner-TLS keys, grants, catalog data and
  recovery secrets never appear in relay frames or status output.
- `SIGTERM`/`SIGINT` send `session-close`, terminate the transport and drain
  the gateway; no timer interrupts a healthy in-flight operation.

The focused suite
`tests/vitest/gateway/private-endpoint/endpoint-profile.test.ts` (registry id
`gateway.private-endpoint-profile`) exercises configuration validation, the
real WebSocket transport lifecycle, admit/reject/reconnect transitions, the
honest state surface, inner-channel dispatch over pinned TLS and signal drain.

## Ownership

| Concern | Owner |
| --- | --- |
| Wire schemas, corpus, limits, state tables | `NODE-PRIVATE-WIRE` (`packages/contracts/src/private-relay/`) |
| Peer mailbox wire schemas, corpus, receipt taxonomy | `NODE-PEER-WIRE` (`packages/contracts/src/private-relay/private-relay-peer.ts`) |
| Mailbox Durable Object runtime | `NODE-MAILBOX-RUNTIME` |
| Relay runtime admission/forwarding (Workerd/DO) | `NODE-RELAY-RUNTIME` |
| Relay metrics exposition, directory inventory fan-out | `NODE-METRICS-EXPORT` (`workers/private-relay/`) |
| Endpoint gateway transitions, operation recovery execution | `NODE-ENDPOINT-GATEWAY` |
| Endpoint trust/recovery proof implementation | `NODE-ENDPOINT-GATEWAY` |
| Endpoint packaging/start/stop/state surface | `NODE-ENDPOINT-PROFILE` (`apps/mcp-gateway-installer/src/private-endpoint/`) |
| Vault storage implementation | `NODE-RELAY-RUNTIME` |

No real cloud deployment, public service publication or hosted identity is
claimed by this contract. Inner-channel encryption profiles (Signal 1:1, MLS
group) and MCP transport semantics remain unchanged by this wire layer.
