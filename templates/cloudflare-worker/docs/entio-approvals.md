# Entio-Signed Approvals for the MCP Gateway

Status: implemented baseline (2026-11-23). This document describes how the
template gateway accepts approval conclusions signed on an Entio phone instead
of — or in addition to — the admin-token `decide` endpoint.

## 1. Goal and trust model

Today a `requiresApproval` tool call mints a pending approval row and only a
holder of `ADMIN_TOKEN` (or the open demo console) can approve it. The target
flow is: **dispatch → phone signs → endpoint executes → report back**:

1. A scoped `tools/call` that needs approval creates the pending permit and a
   bound Entio v2 request, which is pushed to the paired phone through the
   Entio relay.
2. The phone renders the structured request, requires the human's presence,
   and signs a conclusion bound to the request's content digest.
3. The gateway picks the conclusion up from the relay, verifies it against a
   pre-registered approver public key, and only then marks the permit
   `approved`. The caller retries `tools/call` with the `approvalId` and the
   existing single-use permit path executes the upstream call.
4. The audit log records which approver pairing settled the permit.

The Entio threat model is inherited unchanged: **the relay is untrusted**. It
may swap, delay, reorder, or drop messages; tampering can only produce
`invalid`, never a pass. The gateway trusts exactly two things: its own stored
copy of each dispatched request, and the approver device key it pinned at
registration.

## 2. Reused Entio formats

This design reuses the Entio v2 approval contract verbatim — the same format
GitVault, Probator and the account service use — instead of inventing a
gateway-specific signature. The source documents are the Entio repo's
`docs/approval-v2.md` (request/conclusion formats and the §5.1 requester
checklist), `verify/` (the shared requester-side verification library
`entio-verify` / `v2::evaluate` this Worker re-implements in TypeScript), and
`docs/vectors/entio-v2.json` (the compatibility vectors the Worker test suite
re-runs).

### 2.1 Request (what the gateway dispatches)

```json
{
  "v": 2,
  "type": "approval",
  "source": { "system": "meshrix-gateway", "instance": "<deployment name>" },
  "pair": "<pairing UUID>",
  "nonce": "<requester-generated, >=16 chars>",
  "issued_at": 1764000000000,
  "expires_at": 1764001800000,
  "summary": "Approve MCP call deploy via key agent-1",
  "fields": {
    "action": "mcp.tools/call",
    "target": "crm.deploy",
    "key": "agent-1",
    "key_id": "key_abcd",
    "args_sha256": "…64 hex…",
    "approval": "apr_xyz",
    "gateway": "meshrix-mcp-gateway"
  }
}
```

- `action`/`target` are the mandatory `approval` fields; the remaining rows are
  free-form display lines — every field is rendered on the phone and hashed
  into the digest, so the human approves exactly the call the gateway executes.
- `nonce` is a fresh 192-bit base64url value per dispatch — the uniqueness
  anchor. `expires_at` equals the approval row's `expires_at`: the Entio
  decision window is the permit validity (30 min by default, always inside the
  24 h v2 maximum). `issued_at` equals `created_at`.
- This binds the conclusion to the required content: the scoped **key**
  (`key_id`, `key`), the **tool name** (`target`), the **argument digest**
  (`args_sha256`, the same canonical-JSON SHA-256 the permit binds), and the
  **validity window** (`expires_at`).

### 2.2 Conclusion (what the phone signs back)

```json
{
  "v": 2, "pair": "…", "request_digest": "…b64url…",
  "expires_at": 1764001800000, "decision": "approved",
  "decided_at": 1764000060000,
  "signature": "…base64 DER ECDSA…", "pubkey": "…base64 x9.63…"
}
```

- `request_digest = base64url(SHA-256(JCS(request)))`, no padding.
- `signed_message = UTF-8("entio:v2\0" + JCS(conclusion_core))` where
  `conclusion_core` is the six fields `v, pair, request_digest, expires_at,
  decision, decided_at`; `signature` and `pubkey` are unsigned.
- Signature is ECDSA P-256 over SHA-256, **DER encoded**, base64 — the same
  CryptoKit `derRepresentation` encoding v1 used.
- JCS is RFC 8785 restricted to safe integers (`Number.isSafeInteger`); any
  non-integer number makes the value uncanonicalizable.

### 2.3 Why not the other Entio channels

- **v1 pairing verdicts** (`entio:v1|pair|id|req|rid|verdict`) bind only the
  relay-issued `rid`, not content — a relay could show the phone a different
  request and still collect a valid signature. Rejected.
- **The account inbox** (`/account/inbox/{activate,next,received,decision}`)
  forwards to the private `account-service` named entrypoint. That service is
  the only review producer on the channel; a self-hosted gateway cannot inject
  reviews into it. Rejected.
- **The pairing requester queue** (`POST /pair/{id}/requests`,
  `GET /pair/{id}/result?request=<rid>`) is the documented channel for
  third-party requesters (approval-v2.md §7): the relay stores the request
  verbatim, wakes the phone over APNs, and holds the signed conclusion for the
  requester to poll. **Selected.**

## 3. Delivery channel

Each registered pairing stores `relay` (base URL), `pair` (UUID), `secret`
(the pairing credential) and `pubkey` (the pinned device key). The pairing
secret authenticates the gateway to the relay via `x-entio-secret` on every
call:

- Dispatch: `POST {relay}/pair/{pair}/requests`, body = the request JSON.
  `200 {request_id}` records the relay handle (queue addressing only — it
  never enters the signature domain). `400/429/403` or a transport failure
  marks the dispatch `dispatch_failed`; it does not fail the MCP call — the
  approval simply has no phone path until retried.
- Pickup: `GET {relay}/pair/{pair}/result?request={rid}`.
  `{state:"pending"}` leaves the request queued; `{state:"approved"|"rejected",
  conclusion}` is evaluated per §5.1; `{state:"expired"|"cancelled"}` or
  `404 {state:"unknown"}` marks the dispatch `expired`/`lost`.
- After an approval settles, the gateway cancels the remaining queued
  dispatches (`POST /pair/{pair}/cancel {request_id}`) so stale cards
  disappear from the phone.

Relay URLs pass the same `validateUpstreamUrl` SSRF rules as upstream MCP
servers (https, ports 443/8443, no credentials, no private/loopback/metadata
addresses). A `http://` loopback literal is additionally accepted so a local
`selfhost/relay.mjs` can be used under `wrangler dev`.

The Durable Object polls lazily — there is no push path to a Worker and no
alarm wiring in this template. Results are fetched (a) when `tools/call` is
retried against a pending approval that has live dispatches, and (b) on the
explicit `POST /admin/approvals/:id/entio-refresh` endpoint. A Durable Object
alarm that polls on a schedule is a compatible later addition, not required
for correctness.

## 4. Verification in the Worker

`src/entio.ts` re-implements the shared library's `v2::evaluate` in order —
the same checks, same stable invalid reasons:

1. `conclusion.v == 2` and `conclusion.pair == request.pair`.
2. `conclusion.request_digest` equals the digest of the gateway's **stored**
   request copy — never a relay echo.
3. `conclusion.expires_at == request.expires_at`.
4. `decided_at <= expires_at` and verify time `<= expires_at`.
5. `conclusion.pubkey` bytes equal the pinned approver key.
6. ECDSA P-256/SHA-256 verification of `signed_message`; the DER signature is
   converted to the raw `r‖s` form WebCrypto expects.
7. `decision` ∈ {`approved`, `rejected`}; only `approved` releases the permit.

Outcomes: `approved` → permit becomes `approved` (single-use, still consumed
through the existing atomic `UPDATE … WHERE status='approved'` path);
`rejected` → permit becomes `denied` with reason `entio:<label>:rejected` —
a signed denial is a valid conclusion; `invalid` → the dispatch is marked
`invalid` with the reason, the permit stays `pending`, and other registered
pairings may still settle it. An invalid conclusion is never a pass and never
downgrades to a weaker check.

The TypeScript port is pinned against the official `docs/vectors/entio-v2.json`
case set (valid approvals for all four types, a signed rejection, content
swap, expiry, tampered decision) in `test/`.

## 5. Approver key registration and rotation

- `POST /admin/entio/pairings` registers `{label, pubkey}` plus routing —
  either a full `pairCode` (`entio://pair?i=<uuid>&s=<secret>&r=<relay>`) or
  separate `relay`/`pair`/`secret` fields. `pubkey` is the base64 x9.63
  uncompressed P-256 point the phone shows at pairing (also fetchable from the
  relay's `GET /pair/{id}/device`); it is validated by an actual WebCrypto key
  import, which rejects off-curve or malformed points. The admin state view
  exposes the key's SHA-256 fingerprint — grouped hex, the same string the
  phone displays — so the operator can compare it out of band.
- `DELETE /admin/entio/pairings/:label` removes a pairing; its live dispatches
  can never verify again (the pin is gone).
- **Rotation** is re-registration: a re-paired phone yields a new
  pair/secret/pubkey tuple; POST it under the same label to update the row in
  place. Conclusions signed by a superseded key fail the pin check.
- The pairing secret is stored in the Durable Object's private SQLite and is
  never serialized back out — `/admin/state` returns label, relay, pair,
  pubkey and fingerprint only.

## 6. Rejection, expiry and replay behavior

- **Rejection:** a valid signed `rejected` conclusion sets the permit
  `denied`; the caller sees the same single-use denial surface as an admin
  deny (`approval_replay_or_mismatch` on consume).
- **Expiry:** the request's `expires_at` is the permit's `expires_at`, so a
  conclusion that arrives after the window fails step 4 (`invalid`) and the
  permit independently expires — the two clocks cannot disagree. A permit is
  never resurrected.
- **Replay:** releasing a call consumes the permit atomically; a second
  `tools/call` with the same `approvalId` is refused. The conclusion itself
  cannot be replayed onto another request because the signed
  `request_digest`+`pair`+`expires_at` would not match, and the nonce makes
  every dispatch's digest unique. A second conclusion for the same relay
  request id is impossible — the relay deletes the queue entry on decide.
- **Settled permits are final:** once an approval leaves `pending`, later
  conclusions (e.g. a second approver pressing reject) are recorded on their
  dispatch row but never mutate the permit.

## 7. Admin-token fallback

`POST /admin/approvals/:id/decide` remains available as the manual fallback
while `ADMIN_DECIDE_ENABLED` is unset/`"true"`. Setting
`ADMIN_DECIDE_ENABLED="false"` makes the endpoint answer
`403 admin_decide_disabled`, leaving Entio-signed conclusions as the only
approval path. The flag applies in self-hosted and demo mode; default `true`
preserves the deployed template's behavior.

## 8. Non-goals and boundaries

- Entio support is self-hosted only: in `DEMO_MODE` the pairing and refresh
  endpoints answer `403` — the public demo must not become an open outbound
  relay or sign cards on arbitrary phones.
- The gateway does not implement pairing itself; the operator creates the
  pairing on the relay (`POST /pair` or an Entio-side tool), scans it on the
  phone, and registers the resulting credentials here.
- No real pairing, relay, or device key is used by tests — all keys in
  `test/` are synthetic, matching the Entio vector set's test-only key.
- The deployed demo/live instance is untouched: everything here is new code
  behind admin endpoints and a default-on fallback flag.
