# Meshrix MCP Gateway — Cloudflare Workers Template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Meshrix-Platform/Meshrix.js/tree/nightly/templates/cloudflare-worker)

Run a governed **MCP Streamable HTTP gateway** with scoped API keys, JSON Schema 2020-12 parameter validation, single-use human approvals, and content-minimal audit receipts on **Cloudflare Workers + SQLite Durable Objects** — **Free Tier compatible**.

- **Live Demo:** [https://demo.meshrix.io](https://demo.meshrix.io)
- **Zero-eval Schema Engine:** Imports Meshrix's interpreted JSON Schema 2020-12 validator (`compileInterpretedSchema`) with zero `ajv`, zero `new Function`, and zero `node:worker_threads`.

---

## 60-Second Quickstart (Self-Hosted)

Click **Deploy to Cloudflare** above, or deploy from the CLI:

```bash
git clone https://github.com/Meshrix-Platform/Meshrix.js.git
cd Meshrix.js/templates/cloudflare-worker

# 0. Prerequisites: Node.js + npm, and a Cloudflare account
npm install                    # installs the pinned wrangler toolchain
npx wrangler login             # one-time browser login (or export CLOUDFLARE_API_TOKEN)

# 1. Configure a strong admin secret (required for self-hosted /admin/* APIs)
npx wrangler secret put ADMIN_TOKEN
#    On a fresh worker name, wrangler asks to create the Worker first — confirm it.

# 2. Deploy to Cloudflare Workers Free Tier
npx wrangler deploy --config wrangler.jsonc
#    The default worker name is "meshrix-mcp-gateway". To use your own name,
#    pass --name <your-worker-name> (also on `secret put`) or edit wrangler.jsonc.
```

Open your deployed `*.workers.dev` URL in a browser, enter `ADMIN_TOKEN` to unlock the Web Console, register your HTTPS MCP upstream tools, mint scoped API keys, and test live calls and approvals.

### First governed call (curl)

Self-hosted mode only serves tools you register against a real upstream. The gateway forwards each call as a `tools/call` JSON-RPC POST to `upstreamUrl` (HTTPS on port 443 or 8443), performing an on-demand MCP `initialize` handshake automatically if the upstream requires a session. Upstreams that require authentication or request context can be registered with an optional `headers` object of declarative request headers (for example `{"Authorization":"Bearer <token>","x-project-id":"billing"}`), which the gateway attaches to every forwarded call. Header names and values are validated at registration: names must be valid HTTP field names, duplicates are rejected, transport/hop-by-hop names (`host`, `content-length`, `connection`, `accept`, `content-type`, `mcp-session-id`, and similar) are filtered out, values must be strings without control characters, and the map is bounded at 64 headers / 32 KiB. Header **values are write-only**: `GET /admin/state`, the Console, and audit receipts only ever expose the configured header names, never the values. Cloudflare's public documentation MCP works out of the box without any headers:

```bash
GW=https://<your-worker>.workers.dev
# ADMIN = the ADMIN_TOKEN you set with `wrangler secret put` above

# Register an upstream MCP tool (validated by JSON Schema 2020-12)
curl -X POST "$GW/admin/tools" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
    "name": "cfdocs.search",
    "upstreamUrl": "https://docs.mcp.cloudflare.com/mcp",
    "upstreamToolName": "search_cloudflare_documentation",
    "inputSchema": {"type":"object","properties":{"query":{"type":"string","minLength":1}},"required":["query"],"additionalProperties":false}
  }'

# Mint a scoped API key (the token is returned once — save it)
curl -X POST "$GW/admin/keys" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"my-agent","allowedTools":["cfdocs.search"],"ttlSeconds":3600}'

# Call through the gateway: key scope + schema validation + audit receipt
curl -X POST "$GW/mcp" \
  -H "Authorization: Bearer mx_live_..." -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cfdocs.search","arguments":{"query":"durable objects"}}}'
```

Registering a tool with `"requiresApproval": true` makes its `tools/call` return an `approval_required` error carrying an `approvalId`. Approve it with `POST /admin/approvals/<approvalId>/decide` and body `{"decision":"approve"}` (or from the Console), then retry the same call with `"approvalId": "<approvalId>"` inside `params`. Each permit is single-use and bound to the key, tool, and exact arguments. `GET /admin/state` lists tools, key prefixes, approvals, and audit receipts.

### Local Development

```bash
# Optional local admin secret for self-hosted dev mode
printf 'ADMIN_TOKEN=replace-with-local-dev-secret\n' > .dev.vars

npm run dev
```

---

## Architecture

```text
MCP Client / Browser Console
   │
   ├── GET  /health    ──► Worker Edge (0 DO invocations, 0 SQLite rows)
   ├── GET  /          ──► Embedded Web Console SPA (per-request CSP nonce)
   ├── POST /mcp       ──► MeshrixGatewayDO (SQLite Durable Object)
   │                        ├─ Constant-time SHA-256 Bearer API key auth
   │                        ├─ Per-key allowedTools scoping
   │                        ├─ Interpreted JSON Schema 2020-12 validation
   │                        ├─ Single-use approval permit (key_id, tool_name, args_sha256)
   │                        ├─ Strict SSRF-hardened HTTPS upstream fetch (redirect: "error")
   │                        └─ Content-minimal audit_events (args_sha256, no raw payloads)
   └── /admin/*        ──► MeshrixGatewayDO (guarded by constant-time ADMIN_TOKEN)
```

---

## Cloudflare Workers Free Tier Math

Cloudflare Workers **SQLite-backed Durable Objects** are available on the **Workers Free** plan with daily quotas resetting at 00:00 UTC:

| Resource | Workers Free Plan Limit | How This Gateway Optimizes Usage |
| --- | --- | --- |
| **Requests** | **100,000 / day** | `GET /health` and `GET /` respond at the Worker edge with **0 DO requests**. |
| **DO Compute Duration** | **13,000 GB-seconds / day** | Compiled schemas are LRU-cached in DO memory (up to 64 tools); zero codegen overhead. |
| **SQLite Rows Read** | **5,000,000 / day** | Indexed lookups by `token_hash` (API keys) and `(key_id, tool_name, args_sha256)` (approvals). |
| **SQLite Rows Written** | **100,000 / day** | `last_used_at` is debounced (60s); `audit_events` trims via indexed primary-key cutoff (`0–1` excess row deleted per insert). |
| **SQLite Storage** | **5 GB total** (1 GB / DO) | Bounded tables: max 200–2,000 `audit_events` and max 200 `approvals` stored. |

Per-call baseline (after key minting):
- `GET /health` or `GET /`: `0` DO calls, `0` SQLite reads, `0` SQLite writes.
- `POST /mcp` (`tools/call`): `1` DO call, `~3–4` SQLite row reads (key + tool + optional approval), `1–2` SQLite row writes (`audit_events` insert + optional approval consumption/creation + debounced `last_used_at`).

---

## Security & Operational Guardrails

- **Self-Hosted Fail-Closed Admin Auth:** When `DEMO_MODE !== "true"`, all `/admin/*` endpoints return `503` if `ADMIN_TOKEN` is unset and `401` if the Bearer token fails constant-time SHA-256 verification.
- **Public Demo Mode (`DEMO_MODE=true`):** Pre-seeds `demo.echo`, `demo.format_note`, and `demo.sensitive_deploy` (`requiresApproval: true`), rejects `POST /admin/tools` with `403 demo_mode_upstream_disabled`, caps active demo keys at `50` (24h TTL, oldest evicted), and caps `audit_events` at `200` latest rows.
- **SSRF Defense:** Upstream URLs must use `https://` on port `443` or `8443`, cannot include URL credentials, and reject private/loopback/link-local/CGNAT/unspecified/metadata IPv4/IPv6 ranges, `::ffff:` mapped IPv6 addresses, `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, and `metadata.google.internal`. Outbound `fetch` always sets `redirect: "manual"` and refuses redirect responses.
- **Declarative Upstream Headers:** Registered tools may carry an optional `headers` map (per ADR-0001 upstream custom fields) that is forwarded on every `tools/call`. Validation reuses the shared `normalizeUpstreamMcpHttpRequestHeaders` contract; stored values are never returned by `/admin/state`, the Console, or audit receipts — only the header names are listed.
- **Single-Use Approval Binding:** Approval permits are consumed atomically via SQL `UPDATE ... WHERE id = ? AND status = 'approved' AND key_id = ? AND tool_name = ? AND args_sha256 = ? AND consumed_at IS NULL AND expires_at > ?`, blocking replay, argument tampering, and cross-key reuse.
- **Not-Sent Failure Refund:** An upstream failure provably raised before the request left the gateway (SSRF address refusal, pre-dispatch error, or refused redirect) restores the consumed permit to `approved` and the receipt carries `approvalRestored: true`, so the same approval can be redeemed once more. A transport failure that may already have reached upstream keeps the permit consumed and the receipt carries `resultUnknown: true`.
- **Stateful Upstream Sessions:** Upstream `tools/call` is attempted statelessly first; if the server requires a session (HTTP `400` "not initialized / no session" or `404`), the gateway performs an on-demand `initialize` + `notifications/initialized` handshake, carries `Mcp-Session-Id` and `MCP-Protocol-Version` on subsequent calls, and re-handshakes exactly once when the upstream invalidates the session (`404`). Stateless upstreams keep the single-request behavior. Failures surface as `upstream_handshake_failed` or `upstream_session_expired` in the JSON-RPC error `data.code` and audit receipts.
- **Entio-Signed Approvals (self-hosted only):** Register an Entio device pairing (`POST /admin/entio/pairings`) and every pending approval is dispatched to the paired phone through the Entio relay as a content-bound v2 request (key, tool name, argument digest, validity window). Phone-signed conclusions are verified in the DO against the pinned approver P-256 key — JCS digests, `entio:v2\0` domain separation, DER ECDSA — before the permit is released. See [docs/entio-approvals.md](docs/entio-approvals.md).
- **Configurable Admin Fallback:** `POST /admin/approvals/:id/decide` remains available while `ADMIN_DECIDE_ENABLED` is unset/`"true"`; set `ADMIN_DECIDE_ENABLED="false"` to make Entio-signed conclusions the only approval path (`403 admin_decide_disabled`).

---

## Endpoints

- `GET /health` — Edge liveness check
- `GET /` — Embedded Web Console
- `POST /mcp` — MCP Streamable HTTP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`)
- `GET /admin/state` — Tools, keys (prefixes only), approvals, Entio pairings/requests, and audit receipts
- `POST /admin/keys` — Mint a scoped Bearer API key
- `DELETE /admin/keys/:id` — Revoke an API key
- `POST /admin/tools` — Register a validated HTTPS upstream MCP tool (self-hosted mode only); optional `headers` object declares request headers forwarded to the upstream
- `DELETE /admin/tools/:name` — Delete a tool (self-hosted mode only)
- `POST /admin/approvals/:id/decide` — Approve or deny a pending execution request (`{ "decision": "approve" | "deny" }`, disabled when `ADMIN_DECIDE_ENABLED="false"`)
- `POST /admin/entio/pairings` — Register/rotate an Entio approver pairing: `{ label, pubkey, pair, secret, relay }` or a `pairCode` (self-hosted mode only)
- `DELETE /admin/entio/pairings/:label` — Remove an Entio approver pairing (self-hosted mode only)
- `POST /admin/approvals/:id/entio-refresh` — Poll the Entio relay now and evaluate any arrived conclusion (self-hosted mode only)
