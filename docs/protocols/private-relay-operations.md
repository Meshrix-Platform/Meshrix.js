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
- `npm run deploy` targets the `staging` environment in `wrangler.toml`, whose
  `account_id` is the placeholder
  `PLACEHOLDER-REPLACE-ONLY-IN-AUTHORIZED-DEPLOYMENT`. A real deploy is a
  separately authorized delivery: it requires an authorized account id, an
  operator-held `CLOUDFLARE_API_TOKEN`, and `RELAY_ADMIN_TOKEN` provisioned
  through `wrangler secret put` (never as a committed `vars` value).
- The staging block is a config **shape** for environment separation review —
  it contains no real account data and claims no cloud availability.

## Environment separation

`wrangler.toml` carries two profiles:

- **Default / local** — consumed by `wrangler dev --local`,
  `wrangler deploy --dry-run` and the vitest suite. `RELAY_ADMIN_TOKEN` is a
  synthetic local-only value; Durable Object state stays in local
  SQLite/Miniflare.
- **`[env.staging]`** — distinct Worker name
  (`meshrix-private-relay-staging`), placeholder `account_id`, and restated
  bindings/vars/migrations (Wrangler named environments do not inherit them).
  `RELAY_ADMIN_TOKEN` is intentionally absent from staging vars.

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
| Billing counters | Per-operation reads/writes/events/bytes via `GET /admin/counters/...` — counts only |

| The relay never sees | Why |
| --- | --- |
| Frame plaintext | `payload` is opaque base64url ciphertext, forwarded untouched; the relay has no decrypt capability |
| Inner-channel keys, endpoint trust bindings, credentials | `EndpointTrustBinding` material never enters relay admission, attachments or telemetry; `PRIVATE_RELAY_FORBIDDEN_KEYS` rejects smuggled semantic fields at parse time |
| Recovery secrets / decrypt material | Vault stores ciphertext + public verifiers + nonce digests only; proof secrets are never logged or retained |
| Request/response bodies in diagnostics | There is **no request logging**: worker source contains no `console.*` calls; the only diagnostic surface is the metadata-only counters endpoint plus typed error responses |

Socket attachments persist rebuildable routing tags only; durable writes are
confined to bounded transition checkpoints (admit, close, throttled cursor
checkpoints, vault commits) — never per frame.

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
