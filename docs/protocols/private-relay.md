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

## Neutral wire corpus

`private-relay-wire-corpus.json` holds synthetic valid and invalid exemplars
covering every message kind plus: semantic material smuggled into admission or
frames, product-name trust, wrong mode, zero generation, padded/non-canonical
payloads, invented reject reasons, inverted or unknown-cause gaps, cross-purpose
proofs, reusable/expired challenges, missing CAS fields, snapshots carrying
configuration or secrets, lost-ack-as-not-started, completed-without-result,
global-complete rotation claims, generation regressions, unknown trust modes,
and short nonces. All fixtures are neutral — no real credentials, plaintext,
or machine-private data.

The focused suite `tests/vitest/contracts/private-relay-contract.test.ts`
(registry id `contracts.private-relay-wire`) enforces exact-key parsing,
peer agreement on valid messages, rejection of every invalid case, the session
and rotation state machines, reachability/retry honesty, bounded frame
accounting, and snapshot visibility.

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
| Relay runtime admission/forwarding (Workerd/DO) | `NODE-RELAY-RUNTIME` |
| Endpoint gateway transitions, operation recovery execution | `NODE-ENDPOINT-GATEWAY` |
| Endpoint trust/recovery proof implementation | `NODE-ENDPOINT-GATEWAY` |
| Endpoint packaging/start/stop/state surface | `NODE-ENDPOINT-PROFILE` (`apps/mcp-gateway-installer/src/private-endpoint/`) |
| Vault storage implementation | `NODE-RELAY-RUNTIME` |

No real cloud deployment, public service publication or hosted identity is
claimed by this contract. Inner-channel encryption profiles (Signal 1:1, MLS
group) and MCP transport semantics remain unchanged by this wire layer.
