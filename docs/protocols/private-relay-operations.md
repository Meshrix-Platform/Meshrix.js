# Private Relay Operations

> Runtime owner: `workers/private-relay/` (`@meshrix/private-relay-worker`,
> `NODE-RELAY-RUNTIME`, commit `d66af460`). Wire semantics remain owned by
> [Private Relay Wire Protocol](private-relay.md); this document owns the
> operational profile of the actual Worker build: reproducible checks,
> environment separation, the privacy projection, the operational error
> taxonomy and honest capability/cost notes.

This is the relay runbook for `NODE-RELAY-PROFILE`. It describes what exists
today — a local-only Workerd/Durable-Objects runtime — and what a separately
authorized deployment would do. It does not claim cloud deployment, hosted
identity or production provisioning.

## Build, test and deploy commands

All commands run from `workers/private-relay/` (or from the repository root
through `npm --prefix workers/private-relay run <script>`). Registered check
suites in `tools/registry/tests.registry.json` invoke them from the root.

| Command | Registry suite | What it does | Side effects |
| --- | --- | --- | --- |
| `npm run typecheck` | `workers.private-relay-typecheck` | `tsc -p tsconfig.json --noEmit` over `src/`, `test/` and the contracts wire sources | None |
| `npm test` | `workers.private-relay-workerd` | vitest-pool-workers suite (17 tests) on real local Workerd via Miniflare: hibernation eviction/restore, simultaneous connects, stale generation, cross-tenant, revocation, queue exhaustion, vault restart, CAS conflict, wrong-purpose, replay, secret-free serialization | Local `.wrangler/` temp state only |
| `npm run build` | `workers.private-relay-build` | `wrangler deploy --dry-run` — compiles and bundles the Worker (esbuild) and validates `wrangler.toml` bindings, then exits **before upload**. No account, token or network mutation is involved | `.wrangler/` temp dir only |
| `npm run check` | — | `typecheck` + `test` composite for manual use | None |
| `npm run dev` | — | `wrangler dev --local` — local Workerd dev server, never a deploy | Local `.wrangler/` state |
| `npm run deploy` | *(not registered — deliberately)* | `wrangler deploy --env staging` — the documented deploy **shape** only | Would create cloud resources; see boundary below |

### Deployment boundary

- No check, profile, build or `npm run check` path ever runs `wrangler deploy`
  or `npm run deploy`. The `build` script is `wrangler deploy --dry-run`,
  which performs the same bundler/config validation and exits before upload —
  it is the only deploy-shaped command any check executes.
- `npm run deploy` targets the `staging` environment in `wrangler.toml`, which
  carries the real authorized deploy shape (account id, `relay.meshrix.io`
  custom-domain route, `workers_dev = false`, `preview_urls = false`). A
  staging deployment existed, passed live verification, and was then deleted
  after a public-surface security review — nothing is live now. A redeploy is
  a separately authorized operation: it requires the operator-held
  Cloudflare login, `RELAY_INVITE_PUBLIC_KEY` as a `vars` value (the issuer's
  Ed25519 *public* key — public material, safe to commit), plus
  `wrangler secret put` for `RELAY_TICKET_SECRET` (and `RELAY_ADMIN_TOKEN`
  only when an admin surface is intentionally enabled — the public shape
  keeps it off). Invite signing private keys are never committed and never
  live on the relay.
- Public posture for any internet-reachable deploy: `RELAY_ADMIN_SURFACE`
  unset/`"off"` (the `/admin/*` plane does not exist), ticketed credentials,
  HTTPS enforcement with security headers, invite-only admission. Remote
  admin, when needed, rides `RELAY_ADMIN_SURFACE="access"` with a verified
  Cloudflare Access JWT (`RELAY_ACCESS_TEAM` + `RELAY_ACCESS_AUD`).

## Environment separation

`wrangler.toml` carries two profiles:

- **Default / local** — consumed by `wrangler dev --local`,
  `wrangler deploy --dry-run` and the vitest suite. `RELAY_ADMIN_TOKEN` is a
  synthetic local-only value; Durable Object state stays in local
  SQLite/Miniflare.
- **`[env.staging]`** — distinct Worker name
  (`meshrix-private-relay-staging`), the real authorized `account_id`, the
  `relay.meshrix.io` custom-domain route and restated
  bindings/vars/migrations (Wrangler named environments do not inherit them).
  `RELAY_ADMIN_TOKEN` and `RELAY_TICKET_SECRET` are intentionally absent from
  staging vars — they install via `wrangler secret put` under authorized
  ownership. `RELAY_INVITE_PUBLIC_KEY` is the issuer's Ed25519 public
  verification key: it belongs in `vars` (it is public by construction).

## Privacy projection: what the relay can and cannot see

The relay is an opaque forwarding and bounded ciphertext-store service. The
following is the complete metadata surface it observes; anything outside it is
either impossible (ciphertext is never decoded) or deliberately uncollected.

| The relay sees | Form |
| --- | --- |
| Opaque routing identifiers | `tenantId`, `routeId`, `deviceId`, `vaultId` — bounded opaque strings, no semantic content |
| Admission metadata | `role`, `mode`, `admissionGeneration`, `revocationRevision`, `reconnectGeneration`, session purpose (`forward` / `recover_device`) |
| Transport metadata | Message/frame **sizes and counts**, per-direction outstanding bytes/frames, frame sequence ids, ack cursors, connection/disconnection **timing**, pending-socket age, alarm schedule |
| Vault metadata | Opaque vault locator, generation, revision, ciphertext length, ciphertext `sha256` digest, writer/recovery **public** verifier material, single-use nonce **digests** (not nonces) |
| Provider-side transport facts inherent to terminating TLS/WebSocket | Peer IP and connection timing at the edge — collected by Cloudflare, not read, logged or persisted by this Worker's code |
| Billing counters | Per-operation reads/writes/events/bytes via `GET /admin/counters/...` and the Prometheus text exposition at `GET /admin/metrics` — counts and opaque ids only |

| The relay never sees | Why |
| --- | --- |
| Frame plaintext | `payload` is opaque base64url ciphertext, forwarded untouched; the relay has no decrypt capability |
| Inner-channel keys, endpoint trust bindings, credentials | `EndpointTrustBinding` material never enters relay admission, attachments or telemetry; `PRIVATE_RELAY_FORBIDDEN_KEYS` rejects smuggled semantic fields at parse time |
| Recovery secrets / decrypt material | Vault stores ciphertext + public verifiers + nonce digests only; proof secrets are never logged or retained |
| Request/response bodies in diagnostics | There is **no request logging**: worker source contains no `console.*` calls; the only diagnostic surface is the metadata-only counters endpoint plus typed error responses |

Socket attachments persist rebuildable routing tags only; durable writes are
confined to bounded transition checkpoints (admit, close, throttled cursor
checkpoints, vault commits) — never per frame.

### Metrics exposition

`GET /admin/metrics?tenant=<tenantId>[&vault=<vaultId>]` sits on the same
local admin surface as `/admin/counters` (identical `RELAY_ADMIN_TOKEN`
bearer check) and returns a Prometheus text exposition
(`text/plain; version=0.0.4`) instead of JSON. Each `RelayCountersShape`
key becomes one `counter` metric `meshrix_relay_<counter>` labeled
`object` (`session`/`mailbox`/`directory`/`vault`), `tenant`, `route`
(empty for directory/vault), `device` (empty unless mailbox) and `scope`:

- `scope="durable"` — the SQLite-flushed tier (`DURABLE_KEYS` in
  `src/metrics.ts`): storage and admission/revocation/vault/mailbox
  transition counters that survive hibernation eviction.
- `scope="ephemeral"` — the in-memory tier: per-message, per-byte and
  per-event counters that honestly reset on eviction; the label exists so
  dashboards never read them as durable.

The scope label is the tier each reported value actually occupies. When a
deployment disables counter persistence (`RELAY_METRICS_DURABLE = "0"` —
the Workers shape; see the package README), every counted value lives in
memory and reports `scope="ephemeral"`, including `DURABLE_KEYS` counters;
previously persisted values keep `scope="durable"` until the object is
evicted. With persistence disabled, `flush()` is a guaranteed no-op — zero
counter writes to Durable Object storage and no counter write billing.

The fan-out is bounded and enumeration-driven: the tenant directory
reports its own counters plus `GET /internal/inventory` — the same
deduplicated route/device derivation the revoke path uses, sliced to
`RELAY_RUNTIME_LIMITS.maxRoutesPerTenant`/`maxDevicesPerTenant` — and every
enumerated `session:<tenant>/<route>` and `mailbox:<tenant>/<route>/<device>`
object's `/internal/counters` is scraped in parallel. Vault objects have no
tenant registry, so they are scraped only for explicit `vault` query ids
(bounded by the same slice) and summed into one `object="vault"` series —
the label set carries no vault id. Scraping instantiates named objects that
were never active; they report their real (near-zero) counts, never
invented values. Revoked tombstones stay enumerated because their objects
may still hold counters.

The exposition carries counts and opaque routing ids only — no payload
bytes, plaintext, nonces, signatures, credential digests or tokens appear
in metric names, label values or help text.

## Operational error taxonomy

Every rejection/close carries an explicit typed reason; there are no silent
drops or undifferentiated 500s at the protocol surface. Reasons below are the
actual wire/HTTP values emitted by `src/`.

**HTTP router (`src/index.ts`)**: `identity_ambiguous` (malformed opaque id),
`websocket_required`, `unauthorized` (admin surface), `not_found`.

**Session admission and lifecycle (`src/relay-session.ts`)**:

| Reason | Meaning | Client recovery |
| --- | --- | --- |
| `identity_unknown` | Credential digest not enrolled for this tenant/route | Re-provision enrollment, then open a new session |
| `tenant_mismatch` / `mode_mismatch` | Presented binding differs from credential-bound identity/mode | Fix the client binding; retry as a fresh admission |
| `revoked` | Device/route revoked at the directory (current revision) | Terminal for that identity; re-enroll under current authority |
| `stale_revocation_revision` / `authority_stale` | Admission or reconnect cites an older directory revision than current | Re-read directory state; reconnect with a strictly higher `reconnectGeneration` |
| `expired` | Pending socket exceeded `pendingSocketTimeoutMs`, or restored cursor exceeds checkpointed state | Open a fresh session; typed `expired` gaps are reported rather than guessed positions |
| `purpose_denied` | `recover_device` channel attempted a non-recovery message kind | Use a `forward`-purpose session |
| `protocol_error` | Exact-key schema violation, out-of-order lifecycle message, oversized message | Fix the peer; reconnect cleanly |
| `capacity_exceeded` | Receiver outstanding bytes/frames exceed limits, or flooding sender exceeded drop budget | Honor `flow-credit`/backpressure, then reconnect if closed |
| `unreachable` | Peer socket disconnected; frames are never queued for unreachable endpoints | Wait for peer `reachable`, or fail new work visibly (never deferred) |
| `closed` / `idle_timeout` | Socket superseded by same-role reconnect or idle-closed | `session-reconnect` with a higher `reconnectGeneration` restores under rechecked authority |

**Recovery vault (`src/recovery-vault.ts`)**: `not_found` (unprovisioned or
empty vault), `invalid_body`, `already_provisioned`, `capacity_exceeded`,
`payload_too_large_or_invalid`, `unsupported_kind`, `purpose_denied`,
`rate_limited` (retryable, 429), `proof_invalid` (wrong key id, stale
`issuedAt`, bad signature, or spent nonce — signature verification precedes
nonce burn). `vault-write` outcomes are explicit: `committed`, `conflict`
(409, CAS mismatch — idempotent retries of the same digest report
`committed`), `refused` (unregistered writer, generation regression,
vaultId/digest mismatch).

**Safe new-session recovery after provider failure.** A Durable Object
restart, eviction or workerd failure surfaces as socket close; the endpoint
recovers through `session-reconnect` (strictly higher `reconnectGeneration`,
directory re-checked) and receives `session-restored` with typed cursor gaps —
`expired` where checkpoints cannot be honored — instead of fabricated
positions. In-memory flow accounting resets conservatively; durable
admission/revocation/counter authority is preserved. A replayed or
lower-generation reconnect is rejected with `authority_stale`/`expired` rather
than reviving stale state.

## Peer mailbox operations

The peer mailbox kinds (`private-relay-peer.ts`, schema
`v0.0.1:private-relay:peer-1`) ride the same credential-admitted `forward`
session sockets as frame traffic — there is no second peer listener or
connection to provision. Each `(tenantId, routeId, deviceId)` recipient
partition is one SQLite-backed `MailboxDO`; peer requests are bound to the
session identity and re-authorized against the directory per operation.

**Deployment knobs** (`wrangler.toml` vars, clamped to
`PRIVATE_RELAY_PEER_LIMITS`; advertised to devices as
`peer-retention-policy` at session admission and re-served on pull):

| Variable | Effect |
| --- | --- |
| `RELAY_MAILBOX_CAPACITY_BYTES` | Per-partition stored-envelope byte budget; send-time eviction of the oldest envelopes writes `capacity_truncated` gap tombstones |
| `RELAY_MAILBOX_RETENTION_MS` | Envelope age bound; the partition alarm expires envelopes and writes `expired` tombstones |
| `RELAY_MAILBOX_MAX_ITEMS` | Per-partition item count bound; enforced with capacity eviction |

**Peer wire failure surface.** Refusals are typed where the response shape
allows: `peer-bundle-published`/`peer-bundle`/`peer-acked` carry
`PRIVATE_RELAY_PEER_REFUSALS` / `PRIVATE_RELAY_PEER_ACK_REFUSALS` values
(`unpaired`, `revoked`, `format_unsupported`, …); `peer-send` reports
`accepted` / `duplicate` / `conflict` and a revoked or unpaired send is
dropped — the sender reconciles honestly through `peer-status` (position
`0`, empty receipts), never through an invented acceptance. A revoked
device's session socket is closed by the directory path, so peer requests
from it cannot reach a partition. Retention loss is observable, never
silent: `peer-messages.gaps` carries `{fromSeq, toSeq, cause, messageIds}`
tombstones and `peer-status` answers evicted ids with position `0`.

**Client-side surface.** `createPeerSessionChannel` gates outbound peer
requests on live session admission (`peer_channel_not_admitted` when down);
durable outbox entries stay `pending` rather than fabricating positions.
Endpoint operators use the loopback admin routes under `/peer/`; the entry
product exposes `peer.*` ops through its authenticated loopback API. Both
surfaces are record-only and require explicit application-outcome calls —
see the product-surfaces section of
[the wire protocol](private-relay.md#peer-messaging-mailbox) and the
respective app READMEs for the exact routes and ops.

**Verification suites** (`tools/registry/tests.registry.json`):
`workers.private-relay-workerd` covers mailbox runtime semantics on real
local Workerd; `peer.product-wiring` covers endpoint/entry runtime wiring
against a scripted relay; `peer.workerd-e2e` runs two enrolled device
identities exchanging Signal-encrypted request/progress/result through a
real `wrangler dev` relay including disconnect-resume, dedup, receipt
honesty, revoked-device refusal and retention-gap visibility.

## Capability and cost honesty

- **Runtime**: three SQLite-backed Durable Objects behind one Worker. Accepted
  sockets use the WebSocket Hibernation API, so an idle-but-admitted session
  does not hold a continuously-running DO instance; event handlers settle
  after bounded work.
- **Billing shape (Cloudflare DO model, as documented — verify current
  provider pricing before relying on figures)**:
  - DO duration billing drops while a hibernating object has no active work;
    storage and request/event charges continue.
  - WebSocket **inbound** messages to a DO are billed to requests at roughly
    a 20:1 ratio; outbound messages are not billed per message. Frame rate
    limits and bounded outstanding queues in `PRIVATE_RELAY_LIMITS` /
    `RECOVERY_SESSION_LIMITS` are the cost-control mechanism, not per-frame
    durable writes.
  - The relay counts real reads/writes/events/bytes per useful operation
    (`RelayCounters`) instead of inventing monthly cost figures; durable
    counters flush only at bounded transitions.
- **Honest limits** (unchanged from `NODE-RELAY-RUNTIME`, see
  `workers/private-relay/README.md`): single entry+endpoint pair per route
  (no fan-out); opaque bearer credential (not endpoint-pinned identity);
  single-shot vault provisioning; `vault-fetch` proof freshness via bounded
  `issuedAt` + single-use nonce digests with no server-issued challenge
  round-trip; no endpoint gateway semantics, MCP transport, inner encryption,
  client integration or cloud deployment in this package.
