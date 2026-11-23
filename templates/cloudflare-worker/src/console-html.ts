export interface ConsoleRenderOptions {
  readonly demoMode: boolean;
  readonly nonce: string;
}

export function renderConsoleHtml(options: ConsoleRenderOptions): string {
  const modeLabel = options.demoMode ? "PUBLIC DEMO" : "SELF-HOSTED";
  const initialModeJson = JSON.stringify(options.demoMode ? "demo" : "self-hosted");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meshrix MCP Gateway — Cloudflare Edge Console</title>
  <style nonce="${options.nonce}">
    :root {
      --bg: #0b1020;
      --panel: #131a2e;
      --panel-alt: #18223b;
      --border: #263354;
      --text: #e6ecf8;
      --muted: #93a3c4;
      --accent: #38bdf8;
      --accent-strong: #0284c7;
      --good: #22c55e;
      --warn: #f59e0b;
      --bad: #ef4444;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: radial-gradient(circle at top right, #162244 0%, var(--bg) 55%);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 18px 64px; }
    header {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 16px; padding-bottom: 18px; border-bottom: 1px solid var(--border); margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    .brand p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
    .badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      border-radius: 999px; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border); background: var(--panel-alt);
    }
    .badge.demo { border-color: rgba(56, 189, 248, 0.5); color: #7dd3fc; }
    .badge.self { border-color: rgba(34, 197, 94, 0.5); color: #86efac; }
    .banner {
      background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.28);
      border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 18px;
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;
    }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .card {
      grid-column: span 12;
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px;
    }
    @media (min-width: 900px) {
      .span-6 { grid-column: span 6; }
      .span-5 { grid-column: span 5; }
      .span-7 { grid-column: span 7; }
    }
    .card h2 {
      margin: 0 0 10px; font-size: 15px; display: flex; align-items: center;
      justify-content: space-between; gap: 8px;
    }
    label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
    input[type="text"], input[type="password"], select, textarea {
      width: 100%; background: #0c1222; color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 10px; font-size: 13px; font-family: var(--sans);
    }
    textarea, code, pre { font-family: var(--mono); }
    textarea { min-height: 96px; resize: vertical; font-size: 12px; }
    pre {
      margin: 8px 0 0; background: #090e1b; border: 1px solid var(--border);
      border-radius: 8px; padding: 10px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
    button {
      cursor: pointer; border: 1px solid var(--border); background: var(--panel-alt);
      color: var(--text); border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent-strong); border-color: var(--accent); color: #fff; }
    button.good { background: rgba(34, 197, 94, 0.16); border-color: rgba(34, 197, 94, 0.45); color: #86efac; }
    button.bad { background: rgba(239, 68, 68, 0.16); border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
    button.sm { padding: 4px 8px; font-size: 11px; }
    .checks { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .check-item {
      display: flex; align-items: flex-start; gap: 8px; padding: 7px 9px;
      border: 1px solid var(--border); border-radius: 8px; background: #0d1427; font-size: 12px;
    }
    .check-item input { margin-top: 2px; }
    .pill {
      display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
      border: 1px solid var(--border); background: var(--panel-alt);
    }
    .pill.pending, .pill.approval_required { color: #fcd34d; border-color: rgba(245, 158, 11, 0.45); }
    .pill.approved, .pill.allowed, .pill.active { color: #86efac; border-color: rgba(34, 197, 94, 0.45); }
    .pill.denied, .pill.revoked, .pill.error { color: #fca5a5; border-color: rgba(239, 68, 68, 0.45); }
    .pill.consumed { color: #7dd3fc; border-color: rgba(56, 189, 248, 0.45); }
    .table-wrap { overflow-x: auto; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    .mono { font-family: var(--mono); font-size: 11px; }
    .muted { color: var(--muted); font-size: 12px; }
    .secret-box {
      margin-top: 10px; padding: 10px; border-radius: 8px;
      background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.4);
      font-size: 12px;
    }
    .hidden { display: none !important; }
    .status-msg { font-size: 12px; margin-top: 8px; min-height: 18px; color: #7dd3fc; }
    .status-msg.err { color: #fca5a5; }
    .mt-0 { margin-top: 0; }
    .mt-4 { margin-top: 4px; }
    .mt-16 { margin-top: 16px; }
    .mb-6 { margin: 0 0 6px; }
    .gap-10 { gap: 10px; }
    .w-240 { width: 240px; }
    .break-all { word-break: break-all; }
    .col-3 { grid-column: span 3; }
    .col-4 { grid-column: span 4; }
    .col-5 { grid-column: span 5; }
    .col-7 { grid-column: span 7; }
    .inline-check { margin: 0; display: flex; align-items: center; gap: 6px; }
    .check-row { margin: 0; cursor: pointer; }
    .check-head { display: flex; gap: 6px; align-items: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <svg width="34" height="34" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#0f172a" stroke="#38bdf8" stroke-width="1.5"/>
          <path d="M8 22V10l8 6 8-6v12" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="16" cy="16" r="2.2" fill="#22c55e"/>
        </svg>
        <div>
          <h1>Meshrix MCP Gateway</h1>
          <p>Scoped API keys, JSON Schema 2020-12 enforcement, single-use approvals &amp; content-minimal audit receipts on Cloudflare Workers</p>
        </div>
      </div>
      <div class="badges">
        <span id="modeBadge" class="badge">${modeLabel}</span>
        <span class="badge">Cloudflare Workers Free Tier</span>
        <button id="refreshBtn" type="button">Refresh State</button>
      </div>
    </header>

    <div id="demoBanner" class="banner hidden">
      <span><strong>Public Live Demo:</strong> Pre-seeded built-in tools (<code>demo.echo</code>, <code>demo.format_note</code>, <code>demo.sensitive_deploy</code>). Custom upstream URLs are locked (<code>403</code>); demo keys expire in 24h (max 50 active); audit log retains latest 200 events.</span>
    </div>

    <div id="authBanner" class="banner hidden">
      <span><strong>Self-Hosted Admin Auth:</strong> Enter your <code>ADMIN_TOKEN</code> (configured via <code>wrangler secret put ADMIN_TOKEN</code>) to manage keys, upstream tools, and approvals.</span>
      <div class="row mt-0">
        <input id="adminTokenInput" type="password" placeholder="ADMIN_TOKEN" class="w-240" />
        <button id="unlockBtn" class="primary" type="button">Unlock Console</button>
      </div>
    </div>

    <div class="grid">
      <section class="card span-5">
        <h2>1. Mint Scoped API Key</h2>
        <label for="keyNameInput">Key Label</label>
        <input id="keyNameInput" type="text" value="demo-agent" maxlength="80" />
        <label>Allowed Tools (Key Scope)</label>
        <div id="toolScopes" class="checks"></div>
        <div class="row">
          <button id="mintKeyBtn" class="primary" type="button">Mint Scoped Key</button>
        </div>
        <div id="mintResult" class="secret-box hidden">
          <div><strong>Copy your API key now (shown once):</strong></div>
          <div class="row">
            <code id="mintedTokenText" class="break-all"></code>
            <button id="copyTokenBtn" class="sm" type="button">Copy</button>
          </div>
        </div>
        <div id="mintStatus" class="status-msg"></div>

        <h2 class="mt-16">Issued Keys <span id="keyCount" class="muted"></span></h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Scope</th><th>Status</th><th></th></tr></thead>
            <tbody id="keysBody"></tbody>
          </table>
        </div>
      </section>

      <section class="card span-7">
        <h2>2. Interactive Tool Playground (<code>POST /mcp</code>)</h2>
        <label for="playgroundKeyInput">Bearer API Key</label>
        <input id="playgroundKeyInput" type="text" placeholder="Mint a key on the left or paste Bearer token..." />
        <div class="grid gap-10">
          <div class="col-7">
            <label for="toolSelect">Tool</label>
            <select id="toolSelect"></select>
          </div>
          <div class="col-5">
            <label for="approvalIdInput">Approval ID (<code>_meta.approvalId</code>, optional)</label>
            <input id="approvalIdInput" type="text" placeholder="apr_..." />
          </div>
        </div>
        <label for="argsInput">Arguments (JSON)</label>
        <textarea id="argsInput"></textarea>
        <div class="row">
          <button id="runCallBtn" class="primary" type="button">Run tools/call</button>
          <button id="runListBtn" type="button">Run tools/list</button>
          <button id="rerunApprovalBtn" class="good hidden" type="button">Re-run with Approved Permit</button>
        </div>
        <div id="playgroundStatus" class="status-msg"></div>
        <pre id="playgroundOutput">Mint a scoped key, pick a tool, and run tools/call to test schema validation, scoping, and human approvals.</pre>

        <h2 class="mt-16">Connect Any MCP Client</h2>
        <div class="row mt-4">
          <button id="copyConfigBtn" class="sm" type="button">Copy MCP Client JSON</button>
          <button id="copyCurlBtn" class="sm" type="button">Copy curl Command</button>
        </div>
        <pre id="clientSnippet"></pre>
      </section>

      <section id="upstreamCard" class="card hidden">
        <h2>Self-Hosted: Register Validated HTTPS Upstream Tool (<code>POST /admin/tools</code>)</h2>
        <div class="grid gap-10">
          <div class="col-4">
            <label for="upNameInput">Public Tool Name</label>
            <input id="upNameInput" type="text" placeholder="billing.lookup_invoice" />
          </div>
          <div class="col-5">
            <label for="upUrlInput">HTTPS Upstream MCP Endpoint</label>
            <input id="upUrlInput" type="text" placeholder="https://mcp.example.com/mcp" />
          </div>
          <div class="col-3">
            <label for="upToolInput">Upstream Tool Name</label>
            <input id="upToolInput" type="text" placeholder="lookup_invoice" />
          </div>
        </div>
        <label for="upDescInput">Description</label>
        <input id="upDescInput" type="text" placeholder="Read-only invoice lookup" />
        <label for="upHeadersInput">Upstream Request Headers (JSON object, optional — sent on every tools/call; values are write-only and never shown again)</label>
        <textarea id="upHeadersInput" placeholder='{"Authorization":"Bearer <token>","x-project-id":"billing"}'></textarea>
        <label for="upSchemaInput">Input Schema (JSON Schema 2020-12)</label>
        <textarea id="upSchemaInput">{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"invoiceId":{"type":"string","minLength":1}},"required":["invoiceId"],"additionalProperties":false}</textarea>
        <div class="row">
          <label class="inline-check">
            <input id="upApprovalCheck" type="checkbox" /> Requires human approval
          </label>
          <button id="registerToolBtn" class="primary" type="button">Register Upstream Tool</button>
        </div>
        <div id="upstreamStatus" class="status-msg"></div>
      </section>

      <section class="card span-6">
        <h2>3. Live Human Approvals (Single-Use Permits)</h2>
        <p class="muted mb-6">Each permit is bound atomically to <code>(key_id, tool_name, args_sha256)</code> and consumed on first execution.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Approval</th><th>Args Preview &amp; SHA-256</th><th>Status</th><th>Action</th></tr></thead>
            <tbody id="approvalsBody"></tbody>
          </table>
        </div>
      </section>

      <section class="card span-6">
        <h2>4. Content-Minimal Audit Receipts</h2>
        <p class="muted mb-6">Records decision, detail code, latency, and <code>args_sha256</code> — never raw secret payloads.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Event / Tool</th><th>Decision</th><th>SHA-256 / Approval</th></tr></thead>
            <tbody id="auditBody"></tbody>
          </table>
        </div>
      </section>
    </div>
  </div>

  <script nonce="${options.nonce}">
    const INITIAL_MODE = ${initialModeJson};
    const state = {
      mode: INITIAL_MODE,
      adminToken: "",
      activeToken: "",
      data: null,
      pendingCallsByApproval: new Map(),
    };

    const SAMPLE_ARGS = {
      "demo.echo": { message: "Hello Meshrix Edge!", tag: "cf-free-tier" },
      "demo.format_note": { title: "Edge Audit", body: "Verified JSON Schema 2020-12 on Cloudflare Workers.", tags: ["mcp", "edge"] },
      "demo.sensitive_deploy": { service: "payments-api", environment: "production", version: "2.4.0", dryRun: false },
    };

    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "className") node.className = v;
        else if (k === "textContent") node.textContent = v;
        else if (k === "title") node.title = v;
        else if (k === "checked") node.checked = Boolean(v);
        else if (k === "disabled") node.disabled = Boolean(v);
        else node.setAttribute(k, String(v));
      }
      for (const child of children) {
        if (typeof child === "string") node.appendChild(document.createTextNode(child));
        else if (child) node.appendChild(child);
      }
      return node;
    }

    function setMsg(id, msg, isError = false) {
      const node = document.getElementById(id);
      node.textContent = msg;
      node.className = isError ? "status-msg err" : "status-msg";
    }

    function adminHeaders() {
      const headers = { "Content-Type": "application/json" };
      if (state.adminToken) headers["Authorization"] = "Bearer " + state.adminToken;
      return headers;
    }

    function updateClientSnippet() {
      const token = state.activeToken || "<MINTED_API_KEY>";
      const mcpUrl = window.location.origin + "/mcp";
      const snippet = {
        mcpServers: {
          "meshrix-edge": {
            type: "streamable-http",
            url: mcpUrl,
            headers: {
              Authorization: "Bearer " + token,
            },
          },
        },
      };
      document.getElementById("clientSnippet").textContent = JSON.stringify(snippet, null, 2);
    }

    function renderModeChrome() {
      const badge = document.getElementById("modeBadge");
      const demoBanner = document.getElementById("demoBanner");
      const authBanner = document.getElementById("authBanner");
      const upstreamCard = document.getElementById("upstreamCard");
      if (state.mode === "demo") {
        badge.textContent = "PUBLIC DEMO";
        badge.className = "badge demo";
        demoBanner.classList.remove("hidden");
        authBanner.classList.add("hidden");
        upstreamCard.classList.add("hidden");
      } else {
        badge.textContent = "SELF-HOSTED";
        badge.className = "badge self";
        demoBanner.classList.add("hidden");
        authBanner.classList.remove("hidden");
        upstreamCard.classList.remove("hidden");
      }
      updateClientSnippet();
    }

    function renderTools() {
      const tools = state.data?.tools || [];
      const scopesWrap = document.getElementById("toolScopes");
      const prevChecked = new Set(
        Array.from(scopesWrap.querySelectorAll("input[type=checkbox]:checked")).map((i) => i.value),
      );
      const scopeNodes = tools.map((tool) => {
        const checked = prevChecked.size > 0 ? prevChecked.has(tool.name) : true;
        const cb = el("input", { type: "checkbox", value: tool.name, checked });
        const nameEl = el("strong", { className: "mono", textContent: tool.name });
        const meta = tool.requiresApproval ? el("span", { className: "pill pending", textContent: "approval required" }) : null;
        const headerNames = Array.isArray(tool.upstreamHeaderNames) ? tool.upstreamHeaderNames : [];
        const headersPill = headerNames.length > 0
          ? el("span", { className: "pill consumed", title: "Declarative request headers forwarded to the upstream", textContent: "headers: " + headerNames.join(", ") })
          : null;
        const desc = el("div", { className: "muted", textContent: tool.description || tool.upstreamUrl || "" });
        return el("label", { className: "check-item check-row" }, [
          cb,
          el("div", {}, [el("div", { className: "check-head" }, [nameEl, meta, headersPill]), desc]),
        ]);
      });
      scopesWrap.replaceChildren(...scopeNodes);

      const select = document.getElementById("toolSelect");
      const prevSelected = select.value;
      const optionNodes = tools.map((tool) =>
        el("option", { value: tool.name, textContent: tool.requiresApproval ? tool.name + " (approval required)" : tool.name }),
      );
      select.replaceChildren(...optionNodes);
      if (tools.some((t) => t.name === prevSelected)) {
        select.value = prevSelected;
      } else if (tools.length > 0) {
        select.value = tools[0].name;
        loadSampleArgsForTool(tools[0].name);
      }
    }

    function loadSampleArgsForTool(toolName) {
      const sample = SAMPLE_ARGS[toolName] || {};
      document.getElementById("argsInput").value = JSON.stringify(sample, null, 2);
      document.getElementById("approvalIdInput").value = "";
      document.getElementById("rerunApprovalBtn").classList.add("hidden");
    }

    function renderKeys() {
      const keys = state.data?.keys || [];
      document.getElementById("keyCount").textContent = "(" + keys.length + ")";
      const tbody = document.getElementById("keysBody");
      if (keys.length === 0) {
        tbody.replaceChildren(el("tr", {}, [el("td", { colSpan: "4", className: "muted", textContent: "No keys minted yet." })]));
        return;
      }
      const rows = keys.map((k) => {
        const revokeBtn = k.status === "active"
          ? el("button", { type: "button", className: "sm bad", textContent: "Revoke" })
          : null;
        if (revokeBtn) {
          revokeBtn.addEventListener("click", () => revokeKey(k.id));
        }
        return el("tr", {}, [
          el("td", {}, [
            el("div", { textContent: k.name }),
            el("div", { className: "mono muted", textContent: k.prefix }),
          ]),
          el("td", { className: "mono", textContent: (k.allowedTools || []).join(", ") }),
          el("td", {}, [el("span", { className: "pill " + k.status, textContent: k.status })]),
          el("td", {}, [revokeBtn]),
        ]);
      });
      tbody.replaceChildren(...rows);
    }

    function renderApprovals() {
      const approvals = state.data?.approvals || [];
      const tbody = document.getElementById("approvalsBody");
      if (approvals.length === 0) {
        tbody.replaceChildren(el("tr", {}, [el("td", { colSpan: "4", className: "muted", textContent: "No approval requests yet. Try running demo.sensitive_deploy." })]));
        return;
      }
      const rows = approvals.map((a) => {
        const actions = [];
        if (a.status === "pending") {
          const approveBtn = el("button", { type: "button", className: "sm good", textContent: "Approve" });
          approveBtn.addEventListener("click", () => decideApproval(a.id, "approve"));
          const denyBtn = el("button", { type: "button", className: "sm bad", textContent: "Deny" });
          denyBtn.addEventListener("click", () => decideApproval(a.id, "deny"));
          actions.push(approveBtn, denyBtn);
        } else if (a.status === "approved") {
          const rerunBtn = el("button", { type: "button", className: "sm primary", textContent: "Re-run" });
          rerunBtn.addEventListener("click", () => rerunWithApproval(a));
          actions.push(rerunBtn);
        }
        return el("tr", {}, [
          el("td", {}, [
            el("div", { className: "mono", textContent: a.toolName }),
            el("div", { className: "mono muted", textContent: a.id }),
            el("div", { className: "muted", textContent: "Key: " + a.keyName }),
          ]),
          el("td", {}, [
            el("div", { className: "mono", textContent: a.argsPreview }),
            el("div", { className: "mono muted", title: a.argsSha256, textContent: "sha256: " + a.argsSha256.slice(0, 16) + "..." }),
          ]),
          el("td", {}, [el("span", { className: "pill " + a.status, textContent: a.status })]),
          el("td", {}, [el("div", { className: "row mt-0" }, actions)]),
        ]);
      });
      tbody.replaceChildren(...rows);
    }

    function renderAudit() {
      const events = state.data?.auditEvents || [];
      const tbody = document.getElementById("auditBody");
      if (events.length === 0) {
        tbody.replaceChildren(el("tr", {}, [el("td", { colSpan: "4", className: "muted", textContent: "No audit events recorded yet." })]));
        return;
      }
      const rows = events.map((e) => {
        const timeStr = new Date(e.ts).toLocaleTimeString();
        return el("tr", {}, [
          el("td", { className: "mono muted", textContent: timeStr }),
          el("td", {}, [
            el("div", { className: "mono", textContent: e.eventType }),
            el("div", { className: "mono muted", textContent: e.toolName || e.keyId || "-" }),
          ]),
          el("td", {}, [
            el("span", { className: "pill " + e.decision, textContent: e.decision }),
            el("div", { className: "mono muted", textContent: e.detailCode + (e.latencyMs !== null ? " (" + e.latencyMs + "ms)" : "") }),
          ]),
          el("td", { className: "mono muted" }, [
            el("div", { title: e.argsSha256 || "", textContent: e.argsSha256 ? "sha256:" + e.argsSha256.slice(0, 12) + "..." : "-" }),
            e.approvalId ? el("div", { textContent: e.approvalId }) : null,
          ]),
        ]);
      });
      tbody.replaceChildren(...rows);
    }

    async function refreshState() {
      const res = await fetch("/admin/state", { headers: adminHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to load state." }));
        setMsg("mintStatus", err.message || ("HTTP " + res.status), true);
        return;
      }
      state.data = await res.json();
      state.mode = state.data.demoMode ? "demo" : "self-hosted";
      renderModeChrome();
      renderTools();
      renderKeys();
      renderApprovals();
      renderAudit();
    }

    async function mintKey() {
      const name = document.getElementById("keyNameInput").value.trim();
      const allowedTools = Array.from(document.querySelectorAll("#toolScopes input[type=checkbox]:checked")).map((c) => c.value);
      setMsg("mintStatus", "Minting scoped API key...");
      const res = await fetch("/admin/keys", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name, allowedTools }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg("mintStatus", body.message || ("Mint failed: HTTP " + res.status), true);
        return;
      }
      state.activeToken = body.token;
      document.getElementById("mintedTokenText").textContent = body.token;
      document.getElementById("mintResult").classList.remove("hidden");
      document.getElementById("playgroundKeyInput").value = body.token;
      updateClientSnippet();
      setMsg("mintStatus", "Key minted and loaded into Playground.");
      await refreshState();
    }

    async function revokeKey(keyId) {
      const res = await fetch("/admin/keys/" + encodeURIComponent(keyId), {
        method: "DELETE",
        headers: adminHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMsg("mintStatus", body.message || ("Revoke failed: HTTP " + res.status), true);
        return;
      }
      setMsg("mintStatus", "Key revoked: " + keyId);
      await refreshState();
    }

    async function decideApproval(approvalId, decision) {
      const res = await fetch("/admin/approvals/" + encodeURIComponent(approvalId) + "/decide", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ decision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg("playgroundStatus", body.message || ("Decision failed: HTTP " + res.status), true);
        return;
      }
      if (decision === "approve") {
        document.getElementById("approvalIdInput").value = approvalId;
        document.getElementById("rerunApprovalBtn").classList.remove("hidden");
        setMsg("playgroundStatus", "Approved " + approvalId + ". Click 'Re-run with Approved Permit' to execute once.");
      } else {
        setMsg("playgroundStatus", "Denied " + approvalId + ".");
      }
      await refreshState();
    }

    async function rerunWithApproval(approval) {
      document.getElementById("toolSelect").value = approval.toolName;
      document.getElementById("approvalIdInput").value = approval.id;
      const savedArgs = state.pendingCallsByApproval.get(approval.id);
      if (savedArgs !== undefined) {
        document.getElementById("argsInput").value = JSON.stringify(savedArgs, null, 2);
      } else if (SAMPLE_ARGS[approval.toolName]) {
        document.getElementById("argsInput").value = JSON.stringify(SAMPLE_ARGS[approval.toolName], null, 2);
      }
      await runMcpCall();
    }

    async function runMcpList() {
      const token = document.getElementById("playgroundKeyInput").value.trim();
      if (!token) {
        setMsg("playgroundStatus", "Mint or paste a Bearer API key first.", true);
        return;
      }
      setMsg("playgroundStatus", "Calling tools/list...");
      const res = await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ui-list-" + Date.now(), method: "tools/list", params: {} }),
      });
      const body = await res.json().catch(() => ({}));
      document.getElementById("playgroundOutput").textContent = JSON.stringify(body, null, 2);
      setMsg("playgroundStatus", "tools/list HTTP " + res.status, !res.ok || Boolean(body.error));
      await refreshState();
    }

    async function runMcpCall() {
      const token = document.getElementById("playgroundKeyInput").value.trim();
      const toolName = document.getElementById("toolSelect").value;
      const approvalId = document.getElementById("approvalIdInput").value.trim();
      if (!token) {
        setMsg("playgroundStatus", "Mint or paste a Bearer API key first.", true);
        return;
      }
      let args;
      try {
        args = JSON.parse(document.getElementById("argsInput").value || "{}");
      } catch {
        setMsg("playgroundStatus", "Arguments must be valid JSON.", true);
        return;
      }
      const params = { name: toolName, arguments: args };
      if (approvalId) params._meta = { approvalId };

      setMsg("playgroundStatus", "Calling " + toolName + "...");
      const res = await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ui-call-" + Date.now(), method: "tools/call", params }),
      });
      const body = await res.json().catch(() => ({}));
      document.getElementById("playgroundOutput").textContent = JSON.stringify(body, null, 2);

      if (body?.error?.data?.code === "approval_required" && body.error.data.approvalId) {
        const pendingId = body.error.data.approvalId;
        state.pendingCallsByApproval.set(pendingId, args);
        document.getElementById("approvalIdInput").value = pendingId;
        setMsg("playgroundStatus", "Approval required (" + pendingId + "). Approve below, then click Re-run.", false);
      } else if (body?.error) {
        setMsg("playgroundStatus", "Denied: " + (body.error.data?.code || body.error.message), true);
      } else {
        setMsg("playgroundStatus", "Succeeded (" + toolName + ").");
      }
      await refreshState();
    }

    async function registerUpstreamTool() {
      const name = document.getElementById("upNameInput").value.trim();
      const upstreamUrl = document.getElementById("upUrlInput").value.trim();
      const upstreamToolName = document.getElementById("upToolInput").value.trim();
      const description = document.getElementById("upDescInput").value.trim();
      const requiresApproval = document.getElementById("upApprovalCheck").checked;
      let inputSchema;
      try {
        inputSchema = JSON.parse(document.getElementById("upSchemaInput").value || "{}");
      } catch {
        setMsg("upstreamStatus", "inputSchema must be valid JSON.", true);
        return;
      }
      let headers;
      const headersText = document.getElementById("upHeadersInput").value.trim();
      if (headersText) {
        try {
          headers = JSON.parse(headersText);
        } catch {
          setMsg("upstreamStatus", "Upstream request headers must be a valid JSON object.", true);
          return;
        }
      }
      const res = await fetch("/admin/tools", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ name, upstreamUrl, upstreamToolName, description, inputSchema, requiresApproval, headers }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg("upstreamStatus", body.message || ("HTTP " + res.status), true);
        return;
      }
      setMsg("upstreamStatus", "Registered upstream tool: " + body.tool.name);
      await refreshState();
    }

    document.getElementById("refreshBtn").addEventListener("click", refreshState);
    document.getElementById("mintKeyBtn").addEventListener("click", mintKey);
    document.getElementById("runCallBtn").addEventListener("click", runMcpCall);
    document.getElementById("runListBtn").addEventListener("click", runMcpList);
    document.getElementById("rerunApprovalBtn").addEventListener("click", runMcpCall);
    document.getElementById("registerToolBtn").addEventListener("click", registerUpstreamTool);
    document.getElementById("toolSelect").addEventListener("change", (e) => loadSampleArgsForTool(e.target.value));
    document.getElementById("playgroundKeyInput").addEventListener("input", (e) => {
      state.activeToken = e.target.value.trim();
      updateClientSnippet();
    });
    document.getElementById("unlockBtn").addEventListener("click", async () => {
      state.adminToken = document.getElementById("adminTokenInput").value.trim();
      await refreshState();
    });
    document.getElementById("copyTokenBtn").addEventListener("click", () => {
      navigator.clipboard?.writeText(state.activeToken || "").catch(() => {});
      setMsg("mintStatus", "Copied token to clipboard.");
    });
    document.getElementById("copyConfigBtn").addEventListener("click", () => {
      navigator.clipboard?.writeText(document.getElementById("clientSnippet").textContent || "").catch(() => {});
      setMsg("playgroundStatus", "Copied MCP client config JSON.");
    });
    document.getElementById("copyCurlBtn").addEventListener("click", () => {
      const token = state.activeToken || "<MINTED_API_KEY>";
      const cmd = "curl -sS -X POST " + window.location.origin + "/mcp "
        + "-H 'Content-Type: application/json' "
        + "-H 'Authorization: Bearer " + token + "' "
        + "-d '{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"demo.echo\\",\\"arguments\\":{\\"message\\":\\"hello\\"}}}'";
      navigator.clipboard?.writeText(cmd).catch(() => {});
      setMsg("playgroundStatus", "Copied curl command.");
    });

    renderModeChrome();
    if (state.mode === "demo") {
      refreshState();
    }
  </script>
</body>
</html>`;
}
