# Meshrix MCP Gateway — Cloudflare Workers Template

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Meshrix-Platform/Meshrix.js/tree/main/templates/cloudflare-worker)

Run a governed **MCP Streamable HTTP gateway** with scoped API keys, JSON Schema 2020-12 parameter validation, single-use human approvals, and content-minimal audit receipts on **Cloudflare Workers + SQLite Durable Objects** — **Free Tier compatible**.

- **Live Demo:** [https://demo.meshrix.io](https://demo.meshrix.io)
- **Zero-eval Schema Engine:** Imports Meshrix's interpreted JSON Schema 2020-12 validator (`compileInterpretedSchema`) with zero `ajv`, zero `new Function`, and zero `node:worker_threads`.

---

## 60-Second Quickstart (Self-Hosted)

Click **Deploy to Cloudflare** above, or deploy from the CLI:

```bash
git clone https://github.com/Meshrix-Platform/Meshrix.js.git
cd Meshrix.js/templates/cloudflare-worker

# 1. Configure a strong admin secret (required for self-hosted /admin/* APIs)
npx wrangler secret put ADMIN_TOKEN

# 2. Deploy to Cloudflare Workers Free Tier
npx wrangler deploy --config wrangler.jsonc
```

Open your deployed `*.workers.dev` URL in a browser, enter `ADMIN_TOKEN` to unlock the Web Console, register your HTTPS MCP upstream tools, mint scoped API keys, and test live calls and approvals.

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
- **SSRF Defense:** Upstream URLs must use `https://` on port `443` or `8443`, cannot include URL credentials, and reject private/loopback/link-local/CGNAT/unspecified/metadata IPv4/IPv6 ranges, `::ffff:` mapped IPv6 addresses, `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, and `metadata.google.internal`. Outbound `fetch` always sets `redirect: "error"`.
- **Single-Use Approval Binding:** Approval permits are consumed atomically via SQL `UPDATE ... WHERE id = ? AND status = 'approved' AND key_id = ? AND tool_name = ? AND args_sha256 = ? AND consumed_at IS NULL AND expires_at > ?`, blocking replay, argument tampering, and cross-key reuse.

---

## Endpoints

- `GET /health` — Edge liveness check
- `GET /` — Embedded Web Console
- `POST /mcp` — MCP Streamable HTTP (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`)
- `GET /admin/state` — Tools, keys (prefixes only), approvals, and audit receipts
- `POST /admin/keys` — Mint a scoped Bearer API key
- `DELETE /admin/keys/:id` — Revoke an API key
- `POST /admin/tools` — Register a validated HTTPS upstream MCP tool (self-hosted mode only)
- `DELETE /admin/tools/:name` — Delete a tool (self-hosted mode only)
- `POST /admin/approvals/:id/decide` — Approve or deny a pending execution request (`{ "decision": "approve" | "deny" }`)
