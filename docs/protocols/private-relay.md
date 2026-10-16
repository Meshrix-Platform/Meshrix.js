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
these schemas rather than redefining them. The hosted Workerd relay's
build/check/deploy boundary, privacy projection, operational error taxonomy
and cost honesty are maintained in the private operations repository and are
not part of the public source.

## Schema versions

| Surface | Constant | Value |
| --- | --- | --- |
| Session/admission wire | `PRIVATE_RELAY_SCHEMA_VERSION` | `v0.0.1:private-relay:wire-1` |
| Recovery/vault wire | `PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION` | `v0.0.1:private-relay:recovery-1` |
| Peer wire | `PRIVATE_RELAY_PEER_SCHEMA_VERSION` | `v0.0.1:private-relay:peer-1` |
| Wire protocol tag | `PRIVATE_RELAY_WIRE_PROTOCOL` | `meshrix-private-relay/0` |

All messages are strict exact-key JSON objects. Unknown, missing, extra or
misplaced fields are rejected. Changes that alter an existing message shape or
meaning require a new protocol revision; an additive purpose or message in the
unpublished wire contract updates the same constants and neutral corpus.

## Roles, modes and purposes

- Roles: `entry` (installed client), `endpoint` (receiving gateway).
- Modes: `personal`, `enterprise`. A session open whose admission mode does not
  match the enrolled mode is rejected; there is no inferred or fallback mode.
- Session purposes: `forward` (normal opaque forwarding), `recover_device`
  (recovery channel; admits only recovery message kinds plus
  `session-close`/`session-reconnect` — see `recoveryChannelAdmitsOnlyRecovery`),
  and `pair_device` (pairing bootstrap; admits only opaque `frame`,
  `frame-ack`, and `session-close` from the Entry — see
  `pairingChannelAdmitsOnlyPairing`). Unknown purposes are rejected; they never
  fall back to `forward`.
- Before a `pair_device` frame reaches the receiving endpoint, the relay sends
  the endpoint a `pairing-bootstrap` notification containing only the opaque
  `bootstrapId` and the relay-issued `entrySessionId`. The endpoint must
  authenticate the bootstrap through account authority before pinning the
  provisional Entry key, and must reject frames from any other Entry session.
  The notification carries no key, pin, grant, or authorization and is not
  itself authority.

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

## Online peer messaging

The peer wire (`private-relay-peer.ts`, schema
`v0.0.1:private-relay:peer-1`) carries one-to-one Signal ciphertext and
authenticated receipt events over the same admitted `forward` WebSocket as
frame traffic. A route pairs at most one Entry and one endpoint. Directory
checks bind each peer operation to the current authenticated device, route,
pairing and revocation state. The private account-authority binding separately
checks account, epoch, tenant and managed-route currentness once per operation;
both checks remain required. Request-supplied identities never select another
tenant or route, and extra steering fields fail exact-key parsing. Peer messages
are not accepted on recovery or pairing-only channels.

Wire kinds (`PRIVATE_RELAY_PEER_KINDS`):

| Kind | Direction | Semantics |
| --- | --- | --- |
| `peer-bundle-publish` → `peer-bundle-published` | device → Directory → device | Publish a public Signal prekey bundle (`format`, `bundleId`, positive monotonic `revision`, opaque `material`). Directory stores bundle material separately from route inventory and responds `published`/`superseded`/`refused` with the current revision and typed refusal. |
| `peer-bundle-fetch` → `peer-bundle` | device → Directory → device | Fetch only the currently paired peer's public bundle. Response is `available`, `unpublished`, or `refused`; a caller cannot fetch a bundle for an unpaired device. |
| `peer-presence` | relay → paired device | Snapshot or transition for the authenticated local `deviceId` and its exact `peerDeviceId`. `reachable` carries the peer's opaque current session generation; `unreachable` carries `sessionId: null`. This is a retry wakeup, never an authorization token. |
| `peer-send` → `peer-forwarded` | sender → online paired recipient; result to sender | Forward one encrypted envelope only to the exact paired, admitted, online peer. `forwarded` means the socket send was attempted; it is not durable delivery. Offline targets return `endpoint_unreachable`; bounded admission may return `backpressured`; authorization failures are typed `refused`. |
| `peer-delivery-ack` → `peer-forwarded` | recipient → original sender; result to recipient | Forward the recipient's signed receipt to the original sender. The exact original tuple, canonical `sha256:` digest of ciphertext, and XEdDSA signature from the pairing-pinned Signal identity bind the receipt to that message. The recipient persists the receipt before sending; clients verify its signature against the already paired key. The relay does not store it or send an ACK-of-ACK. |

`PeerEnvelope` contains `format`, exact Signal session headers and opaque
`ciphertext`. The relay forwards the envelope bytes unchanged and never sees
plaintext. `containsForbiddenPeerKeys` rejects `grants`, plaintext, tool names,
credentials and agent-intent fields at any nesting depth
(`assertPeerEnvelopeCipherOnly`).

The relay holds no business delivery state: it does not queue an offline
message, save an inbox, create durable positions, persist receipts, or infer
Agent completion. Each client owns its durable outbox, inbox, crypto state and
application status. A send is retried from that local outbox after a matching
`peer-presence` reachability wakeup or a fresh session snapshot. A lost
`peer-forwarded` response does not lose the outbox entry. `peerSendReplayClass`
lets a client resend the same `(tenant, route, sender, recipient, messageId)`
with the same envelope safely; reusing that tuple with different ciphertext
is a local conflict, never a server-side overwrite.

The durable signed receipt means only that the recipient attests it recorded
the exact ciphertext digest. Application execution and task results remain
client-owned state; neither a successful socket send nor a receipt proves
that an Agent executed or completed work.

### Product surfaces (`NODE-PEER-INTEGRATION`)

`PeerClient` (`packages/peer-client`) is the embedded runtime on both ends
of a route. It owns durable file stores — Signal crypto state, the durable
outbox, deduplicated inbox, pending application status and signed receive
receipts — under a caller-chosen state directory. It speaks only the peer
schema kinds on the caller-supplied session channel and replays pending sends
after its paired peer becomes reachable.

`createPeerSessionChannel` (`packages/entry-transport/peer-channel.ts`)
binds that client to the **same** admitted `forward` session the frame
channel rides: outbound peer requests are gated on session admission and
raise the typed `peer_channel_not_admitted` error instead of silently
entering a stale generation. `isPeerSchemaMessage` lets each product demux
peer kinds to `PeerClient.handleInboundMessage` before its session driver
interprets frame/recovery traffic, so no second connection exists.
`peerIdForRouteDevice` derives the deterministic crypto identity
`peer:<tenantId>:<routeId>:<deviceId>`. The peer client resolves a
counterparty's paired Signal identity from the authenticated pairing record,
bound to that route and wire device; it never trusts a relay-delivered key or
an ID derived from an unverified device identifier.

- **Endpoint** (`private-endpoint` profile): `EndpointPeerRuntime` stores
  state under `peer.storageDir` (default `<configDir>/peer-state`,
  owner-only) and exposes the loopback routes `/peer/status`, `/peer/inbox`,
  `/peer/pair-safety` and `/peer/send`. Without an enabled `peer` config
  block these routes answer `404 peer_disabled` and no peer traffic is
  accepted.
- **Entry product** (`apps/entry-native`): `PeerHost` routes application
  events through one `EntryPeerRuntime` per enrolled connection. Each runtime
  stores its durable Peer state under `<dataDir>/peer/<connectionId>/`.
- **Application events** (`@meshrix/peer-client`):
  `PeerApplicationEngine` sends encrypted discovery, task, permission,
  cancellation and result events to an explicitly paired peer. Long logical
  inputs and catalogs are fragmented within the shared wire-size bound and
  reassembled locally before dispatch. Accepted operations are journaled on
  the device before calling the host Agent; duplicate delivery of the same
  operation identity does not call the Agent again.

The peer transport itself records inbound ciphertext in the device's durable
inbox before issuing the pairing-pinned signed receipt. Application events
are decrypted and processed only by the explicitly configured host
integration. The relay does not execute Agent work, infer application
completion, or interpret message plaintext.

This integration supports authenticated one-to-one personal routes; group
and fan-out delivery are outside this wire contract. Device ownership and
team membership come from account and pairing authority, not from a client
supplied routing field.

## Neutral wire corpus

`private-relay-wire-corpus.json` holds synthetic valid and invalid exemplars
covering every message kind plus: semantic material smuggled into admission or
frames, product-name trust, wrong mode, zero generation, padded/non-canonical
payloads, invented reject reasons, inverted or unknown-cause gaps, cross-purpose
proofs, reusable/expired challenges, missing CAS fields, snapshots carrying
configuration or secrets, lost-ack-as-not-started, completed-without-result,
global-complete rotation claims, generation regressions, unknown trust modes,
and short nonces. The `peer` section covers every current wire kind plus
hostile shapes: cross-tenant steering fields, forged presence, replayed
message ids carrying changed ciphertext, envelopes smuggling
`grants`/`plaintext`, invalid ciphertext digests or signatures, self-addressed
sends, unpaired targets and oversized fields. All fixtures are neutral — no
real credentials, plaintext, or machine-private data.

The focused suite `tests/vitest/contracts/private-relay-contract.test.ts`
(registry id `contracts.private-relay-wire`) enforces exact-key parsing,
peer agreement on valid messages, rejection of every invalid case, the session
and rotation state machines, reachability/retry honesty, bounded frame
accounting, and snapshot visibility. For the peer wire it pins exact pairing,
online-only forwarding, local retry identity, signed receipt binding, public
bundle publication and the ciphertext-only envelope boundary.

## Endpoint operator profile

`apps/mcp-gateway-installer` ships the runnable endpoint side of this wire as
`meshrix-gateway private-endpoint serve --config FILE` (with `private-endpoint
check` for offline validation). The profile composes the existing governed
gateway with `createPrivateGatewayEndpoint` over a real `wss:` WebSocket
transport (`ws:` only for literal loopback fixtures) and supervises the session
lifecycle the contract requires:

- The endpoint reports its own session lifecycle separately from the exact
  paired peer's presence. New work requires the intended peer to be reachable
  on an admitted session; otherwise it returns `endpoint_unreachable` and
  remains in the sender's durable pending state for retry with the original
  ciphertext when that peer reconnects. The relay has no offline queue.
- Reconnects preserve session cursors through `session-reconnect`; a
  retryable `session-rejected` is re-presented with the relay-expected
  revocation revision on a fresh session driver, and non-retryable rejections,
  `revoked` closes and protocol failures end the run with a typed outcome.
- Operator-visible revocation and recovery-authority state distinguishes
  locally staged changes from relay-acknowledged ones (`pending` until the
  admission revision catches up — never "applied" off local staging).
- Endpoint administration is not published through the relay: state and
  control are served only on an optional authenticated loopback listener or
  inside the pinned inner channel. The listener requires a bearer from an
  env/file binding or an automatically provisioned owner-only credential
  file. Offline `check` delivers the credential reference, never the secret;
  local callers and endpoint claims resolve that same credential. Supported
  loopback Host/Origin checks and browser preflight do not bypass bearer
  authentication on actual reads or effects. Credentials, inner-TLS keys, grants, catalog data and
  recovery secrets never appear in relay frames or status output.
- `SIGTERM`/`SIGINT` send `session-close`, terminate the transport and drain
  the gateway; no timer interrupts a healthy in-flight operation.

The focused suite
`tests/vitest/gateway/private-endpoint/endpoint-profile.test.ts` (registry id
`gateway.private-endpoint-profile`) exercises configuration validation, the
real WebSocket transport lifecycle, admit/reject/reconnect transitions, the
honest state surface, inner-channel dispatch over pinned TLS and signal drain.

## Ownership

The current delivery's implementation ownership is:

| Concern | Current source | Delivery owner |
| --- | --- | --- |
| Peer wire schemas, corpus, forwarding outcomes and signed-receipt taxonomy | `packages/contracts/src/private-relay/` | `NODE-COST-PEER-WIRE` |
| Online relay, route-scoped presence, Directory bundles and ephemeral metrics | hosted relay runtime (private operations repository) | `NODE-COST-RELAY` |
| Account/epoch/tenant/managed-route authority and device revocation targets | `packages/contracts/src/account/`, hosted account authority (private operations repository) | `NODE-COST-ACCOUNT` |
| Device-local crypto, durable inbox/outbox, receipt replay and paged history | `packages/peer-crypto/`, `packages/peer-client/` | `NODE-COST-PEER-CLIENT` |
| Entry and endpoint application-event journaling, fragmentation and recovery | `apps/entry-native/crates/entry-core/src/peer/`, `apps/mcp-gateway-installer/`, `packages/entry-transport/` | `NODE-COST-APPLICATION` |
| Private local storage and available-capacity checks | `packages/foundation/src/storage/` | `NODE-COST-PRIVATE-IO` |
| Skill Hub registry transaction and legacy-file archive | `services/skill-hub/` | `NODE-COST-SKILL-HUB` |

No real cloud deployment, public service publication or hosted identity is
claimed by this contract. Inner-channel encryption profiles (Signal 1:1, MLS
group) and MCP transport semantics remain unchanged by this wire layer.
