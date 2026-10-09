# `@meshrix/private-relay-worker`

Workerd/Durable-Objects runtime for the Meshrix private relay: authenticated,
hibernating, opaque bounded forwarding plus a bounded recovery-vault API in the
same deployment. It implements the wire contract published in
[`packages/contracts/src/private-relay/`](../../packages/contracts/src/private-relay/index.ts)
(`NODE-PRIVATE-WIRE`, commit `562204d6`) and is the runtime owner assigned to
`NODE-RELAY-RUNTIME` in `docs/plans/workers-privacy`.

**Scope boundary.** Local engineering checks only. There is no Cloudflare
account, deployment, hosted identity or production provisioning in this
package. `wrangler.toml` serves `wrangler dev --local`, `wrangler deploy
--dry-run` and the vitest-pool-workers suite (real local Workerd + Miniflare);
its `[env.staging]` profile is a placeholder-only environment-separation
shape — see
[`docs/protocols/private-relay-operations.md`](../../docs/protocols/private-relay-operations.md)
for the operational runbook (build/test/deploy boundary, privacy projection,
error taxonomy and cost honesty).

## Architecture

| Durable Object | Identity | Owns |
| --- | --- | --- |
| `RelayDirectoryDO` | `directory:<tenantId>` | Tenant enrollment authority: device bindings (credential digest only), route membership, monotonic `revocationRevision`, `admissionGeneration` |
| `RelaySessionDO` | `session:<tenantId>/<routeId>` | Hibernating accepted sockets, admission/reconnect rechecks, bounded ordered opaque frame forwarding, backpressure, revocation push |
| `RecoveryVaultDO` | `vault:<vaultId>` | Committed encrypted snapshot (ciphertext + public verifier + opaque metadata), staged CAS replacement, writer-key set, recovery fetch verifier, single-use proof-nonce digests |

All three use SQLite-backed Durable Object storage
(`new_sqlite_classes` migration) for transactional state.

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
   forwarding frames on a recovery channel is a protocol error.

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
and dropped frames, granted flow credits and vault operations. Durable
counters flush only at bounded transitions; per-message counters are
in-memory. Read via `GET /admin/counters/<session|directory|vault>/...` —
real per-operation counts, no invented monthly cost figures.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | vitest-pool-workers suite in real local Workerd (registry: `workers.private-relay-workerd`) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` (registry: `workers.private-relay-typecheck`) |
| `npm run build` | `wrangler deploy --dry-run` — bundles and validates config, exits before upload (registry: `workers.private-relay-build`) |
| `npm run check` | `typecheck` + `test` composite |
| `npm run dev` | `wrangler dev --local` (never `wrangler deploy`) |
| `npm run deploy` | `wrangler deploy --env staging` — deploy *shape* for a separately authorized delivery only; **never run by any check** (staging `account_id` is a placeholder) |

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
