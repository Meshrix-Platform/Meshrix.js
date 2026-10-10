# `@meshrix/private-relay-worker`

Workerd/Durable-Objects runtime for the Meshrix private relay: authenticated,
hibernating, opaque bounded forwarding plus a bounded recovery-vault API in the
same deployment. It implements the wire contract published in
[`packages/contracts/src/private-relay/`](../../packages/contracts/src/private-relay/index.ts)
(`NODE-PRIVATE-WIRE`, commit `562204d6`) and is the runtime owner assigned to
`NODE-RELAY-RUNTIME` in `docs/plans/workers-privacy`.

**Scope boundary.** Local engineering checks are the default —
`wrangler.toml` serves `wrangler dev --local`, `wrangler deploy --dry-run`
and the vitest-pool-workers suite (real local Workerd + Miniflare). The
`[env.staging]` profile is the authorized Cloudflare deploy shape (real
account id, `relay.meshrix.io` custom-domain route): a staging deployment
existed and passed a complete live peer-e2e, then was deliberately deleted
after a public-surface security review — **nothing is live on Cloudflare
now**, and redeploying is a separately authorized operation. See
[`docs/protocols/private-relay-operations.md`](../../docs/protocols/private-relay-operations.md)
for the operational runbook (build/test/deploy boundary, privacy projection,
error taxonomy and cost honesty).

## Architecture

| Durable Object | Identity | Owns |
| --- | --- | --- |
| `RelayDirectoryDO` | `directory:<tenantId>` | Tenant enrollment authority: device bindings (credential digest only), route membership, monotonic `revocationRevision`, `admissionGeneration`, route-peer pairing resolution |
| `RelaySessionDO` | `session:<tenantId>/<routeId>` | Hibernating accepted sockets, admission/reconnect rechecks, bounded ordered opaque frame forwarding, backpressure, revocation push, peer-mailbox channel dispatch and live delivery pushes |
| `RecoveryVaultDO` | `vault:<vaultId>` | Committed encrypted snapshot (ciphertext + public verifier + opaque metadata), staged CAS replacement, writer-key set, recovery fetch verifier, single-use proof-nonce digests |
| `MailboxDO` | `mailbox:<tenantId>/<routeId>/<deviceId>` | Per-recipient peer mailbox partition: monotonic positions, opaque envelopes, sender-scoped idempotency, typed receipts, prekey bundle, retention/capacity truncation tombstones |

All four use SQLite-backed Durable Object storage
(`new_sqlite_classes` migrations; the mailbox ships under the `peer` tag).

### Privacy / opacity invariants

- Socket attachments store **rebuildable routing tags only** (opaque ids,
  role, mode, revisions, purpose). No credentials, signatures, nonces,
  payload bytes or inner key material are ever attached or persisted.
- Frame payloads are forwarded as the original untouched wire text; the relay
  never decodes, logs or durably stores them. Per-message durable writes are
  limited to bounded transition checkpoints (admit, close, throttled cursor
  checkpoints) — never per frame.
- Vault storage holds ciphertext, public verification material, writer key
  references and proof-nonce **digests** only. A snapshot is never accepted
  as semantic authority and never reduces generation state.
- Mailbox partitions store opaque Signal-family envelopes, positions,
  envelope **hashes**, typed receipts, ids and counters only. The test
  suite audits every stored object against the contract's
  `containsForbiddenPeerKeys` boundary — plaintext, grants, tool names,
  credentials and agent intent never reach durable state.

### Session admission

1. `GET /session/:tenantId/:routeId` with `Upgrade: websocket` and
   `Authorization: Bearer <enrolled credential>`. The session object checks
   the credential **digest** against the tenant directory (issued once at
   `POST /admin/tenants/:tenantId/enroll`; only the SHA-256 digest is
   stored). The credential is bound to `(deviceId, routeId, role, mode)` —
   cross-tenant or mismatched identities are rejected before acceptance.
2. The first socket message must be `session-open` or `session-reconnect`;
   the presented `RelayAdmissionBinding` must equal the credential-bound
   identity exactly, and the directory's **current** revocation revision is
   re-checked on every (re)admission. `session-reconnect` additionally
   requires the previous session and a strictly higher `reconnectGeneration`,
   then answers `session-restored` with typed cursor gaps.
3. `recover_device`-purpose sessions admit only the recovery message kinds
   (`recoveryChannelAdmitsOnlyRecovery`) on an independent, tighter budget —
   forwarding frames or peer mailbox traffic on a recovery channel is a
   protocol error.

### Peer mailbox

`forward`-purpose sessions additionally dispatch the peer wire
(`v0.0.1:private-relay:peer-1`) as request/response on the same admitted
socket. The session object binds every request to the credential-authenticated
identity (`tenantId`/`routeId`/`deviceId` must equal the session binding —
a mismatch is a protocol error), picks the owning partition and stamps the
session's `revocationRevision`/`admissionGeneration`; `MailboxDO`
re-validates the binding and the route pairing against the directory before
touching durable state.

- **Partitions** — one `MailboxDO` per `(tenantId, routeId, deviceId)`
  recipient slot. `peer-send`/`peer-bundle-fetch` are routed to the named
  peer's partition; `peer-bundle-publish`/`peer-fetch`/`peer-ack` hit the
  caller's own; `peer-receipt` resolves the paired peer through the
  directory so sender status queries land on the recipient partition.
- **Sends** — `peer-send` commits `{position, senderDeviceId, messageId,
  envelope}` transactionally with a `mailbox`-issued `accepted` receipt and
  a sender-scoped idempotency binding `(sender, messageId) → (position,
  envelopeHash)`. Same-id/same-envelope replays the stored `accepted`
  outcome (`duplicate`); same-id/different-envelope is a typed `conflict`.
  Positions are monotonic per partition and never rewind, even across
  object eviction.
- **Fetches** — `peer-fetch` is an indexed cursor read (`afterSeq`,
  bounded `limit`) returning strictly ascending positions, `nextAfterSeq`,
  `more` and `gaps` tombstones covering every truncated range in the page —
  a cursor never silently advances past lost messages.
- **Acks** — `peer-ack` records `received` receipts (advancing the durable
  recipient cursor) and verbatim `source:"agent"` application reports in
  one transaction; every requested id is either `recorded` or `refused`
  with `message_unknown`/`position_mismatch`/`authority_stale`/`revoked`.
  A revoked partition refuses each entry honestly.
- **Status** — `peer-receipt` returns per-messageId `position` (`0` =
  unknown) plus recorded receipts, `accepted`/`received`/application kinds
  kept independent.
- **Bundles** — a device publishes its prekey bundle into its own
  partition with monotonic `revision` (`published` first, `superseded` on
  replacement, `refused` with `stale_revision`/`revoked`/`peer_unpaired`
  otherwise); fetches are allowed only for the device's paired route peer.
- **Wakeup** — a committed send pushes the next `peer-messages` page to
  the recipient's live session socket; `peer-fetch` pull remains the
  supported fallback for disconnected or lagging recipients.
- **Retention** — the deployment policy (`RELAY_MAILBOX_CAPACITY_BYTES`,
  `RELAY_MAILBOX_RETENTION_MS`, `RELAY_MAILBOX_MAX_ITEMS`, bounded by
  `PRIVATE_RELAY_PEER_LIMITS`) is advertised at session admission via
  `peer-retention-policy` and re-served on pull. Capacity overflow evicts
  the oldest envelopes; a single scheduled alarm expires by retention —
  both write `expired`/`capacity_truncated` tombstones and only exist
  while data is stored.

### Flow control and backpressure

Per direction, the relay tracks each receiver's outstanding bytes/frames
against `PRIVATE_RELAY_LIMITS` (or `RECOVERY_SESSION_LIMITS` on recovery
routes). Queue exhaustion is rejected **before** a frame is accepted;
`frame-ack` releases budget and emits `flow-credit` to the sender. Senders
that keep flooding a full queue are closed with `capacity_exceeded`. A
disconnected peer makes the route `unreachable`; frames are never queued for
unreachable endpoints (`PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES === false`).

### Recovery vault

- `POST /vault/:vaultId` accepts `vault-fetch` and `vault-write` recovery
  messages. `vault-fetch` verifies a **recovery-public-key proof**
  (`fetchProof`) — sufficient for ciphertext retrieval without any old
  device or account session, and it grants nothing else. `vault-write`
  requires a registered writer key plus `expectedRevision` CAS;
  `sha256` snapshot digests bind each write auth, nonces are single-use
  (digest-only retention), and `issuedAt` freshness is bounded.
- Staged replacement keeps the last committed snapshot until the staged
  write validates and commits atomically; retried writes reconcile
  idempotently (a repeat of an already-committed write reports `committed`,
  divergent writes report `conflict`). Snapshot `generation` may never
  decrease.
- Proof transcripts are canonical `|`-joined strings documented in
  `src/vault-crypto.ts`. Provisioning of writer/recovery keys uses the local
  admin route — public verifiers are never write credentials.

### Metering

Each object counts storage reads/writes/deletes, websocket/HTTP events,
messages and bytes, admitted/rejected/closed/restored sessions, forwarded
and dropped frames, granted flow credits, vault operations and mailbox
operations (`accepted`/`duplicate`/`conflict`/`fetched`/`acked`/`expired`/
`refusals`/`bundles`). Durable counters flush only at bounded transitions;
per-message counters are in-memory. Read via
`GET /admin/counters/<session|directory|vault|mailbox>/...` —
real per-operation counts, no invented monthly cost figures.

`GET /admin/metrics?tenant=<tenantId>[&vault=<vaultId>]` exports the same
counters as a Prometheus text exposition (`text/plain; version=0.0.4`):
`meshrix_relay_<counter>` series labeled `object`, `tenant`, `route`,
`device` and `scope` (`durable` for the SQLite-flushed tier, `ephemeral`
for in-memory counters). The tenant directory's bounded
`/internal/inventory` enumeration drives the fan-out over session and
mailbox objects; vault objects are scraped only for explicit `vault` ids
and summed into one series. Counts and opaque ids only — never payloads,
credentials, digests or nonces.

The Meshrix Console renders this exposition natively (no external
monitoring stack): set `MESHRIX_RELAY_METRICS_URL` to the relay's
`/admin/metrics` URL on the platform server, and
`MESHRIX_RELAY_ADMIN_TOKEN` to the admin bearer credential when the
endpoint requires one. `system.relay_traffic`
(`GET /api/system/relay-traffic`) then returns the parsed series plus a
bounded in-process history for the ops-monitor Relay 流量 panel. The
history ring is in-memory by default; set `MESHRIX_RELAY_TRAFFIC_PERSIST`
to a file path to keep it across server restarts (`"1"` uses the default
`<userDataPath>/relay-traffic-history.json`).

### Counter persistence is a deployment choice (`RELAY_METRICS_DURABLE`)

Durable counter writes are billed Durable Object storage writes. Workers
mode therefore sets `RELAY_METRICS_DURABLE = "0"` in the staging profile —
every counter stays on the in-memory tier, `flush()` becomes a guaranteed
no-op and **zero counter writes reach DO SQLite**. The exposition and the
counters endpoint keep serving real values, honestly labeled
`scope="ephemeral"` (the scope label is the tier a value actually occupies;
a durable-class counter routed to memory reports `ephemeral`, and
previously persisted data keeps its `durable` label). Self-hosted and local
shapes keep the default durable tier — the top-level `[vars]` deliberately
leaves the var unset — and `"0"`/`"false"`/`"off"` (case-insensitive) are
the recognized off values.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | vitest-pool-workers suite in real local Workerd (registry: `workers.private-relay-workerd`) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` (registry: `workers.private-relay-typecheck`) |
| `npm run build` | `wrangler deploy --dry-run` — bundles and validates config, exits before upload (registry: `workers.private-relay-build`) |
| `npm run check` | `typecheck` + `test` composite |
| `npm run dev` | `wrangler dev --local` (never `wrangler deploy`) |
| `npm run deploy` | `wrangler deploy --env staging` — real authorized deploy shape (real `account_id`, custom-domain route); **never run by any check**, redeploy requires explicit authorization plus `wrangler secret put` secrets |

## Deliberate skeleton boundaries (flagged honestly)

- Relay-level authentication is an opaque bearer credential issued by the
  local provisioning route — sufficient for the local authority model, not a
  substitute for the endpoint-pinned identity channels the full profile
  requires.
- One route binds one `entry` and one `endpoint` device (no fan-out);
  a second same-role connection supersedes the earlier one.
- `route-query` answers only for the object's own route; the vault
  provisioning API is single-shot (key rotation remains endpoint-owned).
- `vault-fetch` proof freshness uses `issuedAt` within a bounded clock
  window plus single-use nonce digests; there is no server-issued vault
  challenge round-trip (the `recover_device` challenge flow lives at the
  endpoint, per the contract's ownership split).
- In-memory flow accounting resets conservatively on hibernation eviction;
  cursors are checkpointed at throttle and the restore path reports typed
  `expired` gaps rather than guessing unflushed positions.
