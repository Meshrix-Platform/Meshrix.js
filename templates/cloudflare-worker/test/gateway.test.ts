import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.ts";
import { constantTimeEqualBytes, MeshrixGatewayDO, type GatewayEnv } from "../src/gateway-do.ts";
import { safeUpstreamFetch, UpstreamUrlError, validateUpstreamUrl } from "../src/ssrf.ts";

class InMemorySqlStorage {
  readonly db = new DatabaseSync(":memory:");

  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ) {
    const trimmed = query.trim();
    if (bindings.length === 0 && trimmed.includes(";") && /^(?:CREATE|PRAGMA|BEGIN|COMMIT|DROP)/iu.test(trimmed)) {
      this.db.exec(trimmed);
      return { toArray: () => [] as T[], rowsRead: 0, rowsWritten: 0 };
    }
    const stmt = this.db.prepare(trimmed);
    const upper = trimmed.toUpperCase();
    if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
      const rows = stmt.all(...(bindings as never[])) as T[];
      return {
        toArray: () => rows,
        rowsRead: rows.length,
        rowsWritten: 0,
      };
    }
    if (/\bRETURNING\b/iu.test(trimmed)) {
      const rows = stmt.all(...(bindings as never[])) as T[];
      return {
        toArray: () => rows,
        rowsRead: 0,
        rowsWritten: rows.length,
      };
    }
    const res = stmt.run(...(bindings as never[]));
    return {
      toArray: () => [] as T[],
      rowsRead: 0,
      rowsWritten: Number(res.changes ?? 0),
    };
  }
}

function createHarness(envOverrides: Partial<GatewayEnv> = {}) {
  const sql = new InMemorySqlStorage();
  const state = {
    storage: { sql },
    blockConcurrencyWhile: async <T>(cb: () => Promise<T>) => cb(),
  } as unknown as DurableObjectState;

  let gatewayDo: MeshrixGatewayDO | null = null;
  let doGetCalls = 0;

  const env: GatewayEnv = {
    DEMO_MODE: envOverrides.DEMO_MODE ?? "false",
    ADMIN_TOKEN: envOverrides.ADMIN_TOKEN,
    GATEWAY: {
      idFromName: (name: string) => ({ toString: () => `do:${name}` }) as DurableObjectId,
      get: () => {
        doGetCalls += 1;
        if (!gatewayDo) {
          gatewayDo = new MeshrixGatewayDO(state, env);
        }
        return {
          fetch: (input: Request | string, init?: RequestInit) => {
            const req = input instanceof Request ? input : new Request(input, init);
            return gatewayDo!.fetch(req);
          },
        } as DurableObjectStub<MeshrixGatewayDO>;
      },
    } as unknown as DurableObjectNamespace<MeshrixGatewayDO>,
  };

  const request = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://gateway.example${path}`, init), env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as ExecutionContext);

  const mcp = (token: string | null, payload: unknown, extraHeaders: Record<string, string> = {}) =>
    request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });

  return {
    env,
    sql,
    request,
    mcp,
    getDoCallCount: () => doGetCalls,
  };
}

describe("Cloudflare Worker SSRF validator", () => {
  it("allows valid HTTPS URLs on ports 443 and 8443", () => {
    const cloudflareDnsIp = [1, 1, 1, 1].join(".");
    expect(validateUpstreamUrl("https://mcp.example.com/mcp").hostname).toBe("mcp.example.com");
    expect(validateUpstreamUrl("https://mcp.example.com:443/v1").port).toBe("");
    expect(validateUpstreamUrl("https://mcp.example.com:8443/v1").port).toBe("8443");
    expect(validateUpstreamUrl(`https://${cloudflareDnsIp}/mcp`).hostname).toBe(cloudflareDnsIp);
  });

  it("blocks non-HTTPS, credentials, non-443/8443 ports, local names, and private/metadata/mapped IPs", () => {
    const rfc1918A = [10, 0, 0, 5].join(".");
    const rfc1918B1 = [172, 16, 0, 1].join(".");
    const rfc1918B2 = [172, 31, 255, 254].join(".");
    const rfc1918C = [192, 168, 1, 10].join(".");
    const mappedPublic = [8, 8, 8, 8].join(".");
    const blocked = [
      "http://mcp.example.com/mcp",
      "ftp://mcp.example.com/file",
      "https://user:secret@mcp.example.com/mcp",
      "https://token@mcp.example.com/mcp",
      "https://mcp.example.com:8080/mcp",
      "https://mcp.example.com:80/mcp",
      "https://localhost/mcp",
      "https://localhost./mcp",
      "https://sub.localhost/mcp",
      "https://printer.local/mcp",
      "https://api.internal/mcp",
      "https://router.home.arpa/mcp",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://metadata/computeMetadata/v1/",
      "https://127.0.0.1/mcp",
      `https://${rfc1918A}/mcp`,
      `https://${rfc1918B1}/mcp`,
      `https://${rfc1918B2}/mcp`,
      `https://${rfc1918C}/mcp`,
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/mcp",
      "https://100.127.255.254/mcp",
      "https://0.0.0.0/mcp",
      "https://224.0.0.1/mcp",
      "https://0x7f000001/mcp",
      "https://2130706433/mcp",
      "https://[::1]/mcp",
      "https://[::]/mcp",
      "https://[fc00::1]/mcp",
      "https://[fd00:ec2::254]/latest/meta-data/",
      "https://[fe80::1]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://[::ffff:169.254.169.254]/mcp",
      "https://[::ffff:7f00:1]/mcp",
      `https://[::ffff:${mappedPublic}]/mcp`,
    ];

    for (const candidate of blocked) {
      expect(() => validateUpstreamUrl(candidate), candidate).toThrowError(UpstreamUrlError);
    }
  });

  it("forces redirect: manual on outbound upstream fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
    await safeUpstreamFetch("https://mcp.example.com/mcp", { method: "POST" }, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("rejects a redirect response with upstream_redirect_refused", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://mcp.example.com/moved" },
        }),
    );
    await expect(
      safeUpstreamFetch("https://mcp.example.com/mcp", { method: "POST" }, fetchMock),
    ).rejects.toMatchObject({
      name: "UpstreamUrlError",
      code: "upstream_redirect_refused",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Meshrix Cloudflare Worker Gateway", () => {
  it("serves /health at the edge without invoking DO and sets CSP nonce headers on /", async () => {
    const h = createHarness({ DEMO_MODE: "true" });
    const healthRes = await h.request("/health");
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({ ok: true, mode: "demo" });
    expect(h.getDoCallCount()).toBe(0);

    const htmlRes = await h.request("/");
    expect(htmlRes.status).toBe(200);
    const csp = htmlRes.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("style-src 'nonce-");
    expect(htmlRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(htmlRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await htmlRes.text();
    expect(html).toContain("PUBLIC DEMO");
    expect(h.getDoCallCount()).toBe(0);
  });

  it("uses fixed-length XOR comparison for constantTimeEqualBytes", () => {
    const a = new Uint8Array(32).fill(0xab);
    const b = new Uint8Array(32).fill(0xab);
    const c = new Uint8Array(32).fill(0xab);
    c[31] = 0xac;
    const d = new Uint8Array(31).fill(0xab);
    expect(constantTimeEqualBytes(a, b)).toBe(true);
    expect(constantTimeEqualBytes(a, c)).toBe(false);
    expect(constantTimeEqualBytes(a, d)).toBe(false);
  });

  it("fails closed on /admin/* when ADMIN_TOKEN is unset or invalid in self-hosted mode", async () => {
    const unconfigured = createHarness({ DEMO_MODE: "false" });
    const res503 = await unconfigured.request("/admin/state");
    expect(res503.status).toBe(503);
    expect(await res503.json()).toMatchObject({ error: "admin_token_unconfigured" });

    const configured = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: "super-secret-admin-token" });
    const noAuth = await configured.request("/admin/state");
    expect(noAuth.status).toBe(401);
    const wrongAuth = await configured.request("/admin/state", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuth.status).toBe(401);

    const okAuth = await configured.request("/admin/state", {
      headers: { Authorization: "Bearer super-secret-admin-token" },
    });
    expect(okAuth.status).toBe(200);
    expect(await okAuth.json()).toMatchObject({ demoMode: false, mode: "self-hosted" });
  });

  it("enforces key scoping, revocation, and interpreted JSON Schema 2020-12 validation", async () => {
    const h = createHarness({ DEMO_MODE: "true" });

    const mintRes = await h.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "echo-only", allowedTools: ["demo.echo"] }),
    });
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as { key: { id: string }; token: string };
    expect(minted.token.startsWith("mx_demo_")).toBe(true);

    // MCP initialize + notifications/initialized + ping
    const initRes = await h.mcp(minted.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(initRes.status).toBe(200);
    expect((await initRes.json() as any).result.protocolVersion).toBe("2025-11-25");

    const notifRes = await h.mcp(minted.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notifRes.status).toBe(202);

    const pingRes = await h.mcp(minted.token, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await pingRes.json() as any).result).toEqual({});

    // Scoped tools/list only includes demo.echo
    const listRes = await h.mcp(minted.token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((t) => t.name)).toEqual(["demo.echo"]);

    // Out-of-scope tool rejected
    const outOfScopeRes = await h.mcp(minted.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "demo.format_note", arguments: { title: "hi", body: "there" } },
    });
    expect((await outOfScopeRes.json() as any).error.data.code).toBe("tool_not_in_scope");

    // Invalid schema arguments rejected before execution
    const invalidArgsRes = await h.mcp(minted.token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "demo.echo", arguments: { message: "", unexpected: true } },
    });
    expect((await invalidArgsRes.json() as any).error.data.code).toBe("schema_validation_failed");

    // Valid call succeeds & records content-minimal audit receipt (no raw payload)
    const secretPayload = "sensitive-echo-marker-should-not-hit-audit";
    const okCallRes = await h.mcp(minted.token, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "demo.echo", arguments: { message: secretPayload } },
    });
    const okCallBody = (await okCallRes.json()) as any;
    expect(okCallBody.result.structuredContent.echoed).toBe(secretPayload);

    const stateRes = await h.request("/admin/state");
    const stateBody = (await stateRes.json()) as { auditEvents: Array<Record<string, unknown>> };
    const latestAudit = stateBody.auditEvents[0]!;
    expect(latestAudit.toolName).toBe("demo.echo");
    expect(latestAudit.decision).toBe("allowed");
    expect(latestAudit.argsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stateBody.auditEvents)).not.toContain(secretPayload);

    // Revoke key -> subsequent MCP call fails 401
    const revokeRes = await h.request(`/admin/keys/${encodeURIComponent(minted.key.id)}`, { method: "DELETE" });
    expect(revokeRes.status).toBe(200);
    const revokedMcpRes = await h.mcp(minted.token, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect(revokedMcpRes.status).toBe(401);
    expect((await revokedMcpRes.json() as any).error.data.code).toBe("api_key_revoked");
  });

  it("enforces atomic single-use approval binding, blocks replay, arg tampering, and cross-key reuse", async () => {
    const h = createHarness({ DEMO_MODE: "true" });

    const key1 = (await (await h.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent-1", allowedTools: ["demo.sensitive_deploy"] }),
    })).json()) as { token: string };

    const key2 = (await (await h.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent-2", allowedTools: ["demo.sensitive_deploy"] }),
    })).json()) as { token: string };

    const deployArgs = { service: "billing", environment: "production", version: "2.1.0" };

    // 1. Initial call creates pending approval
    const firstRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs },
    });
    const firstBody = (await firstRes.json()) as any;
    expect(firstBody.error.data.code).toBe("approval_required");
    const approvalId = firstBody.error.data.approvalId as string;
    expect(approvalId).toMatch(/^apr_/u);

    // 2. Approve it
    const approveRes = await h.request(`/admin/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(approveRes.status).toBe(200);

    // 3. Cross-key reuse fails and does not consume
    const wrongKeyRes = await h.mcp(key2.token, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs, _meta: { approvalId } },
    });
    expect((await wrongKeyRes.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

    // 4. Arg-tampered call fails and does not consume
    const tamperedRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "demo.sensitive_deploy",
        arguments: { ...deployArgs, version: "2.1.1-evil" },
        _meta: { approvalId },
      },
    });
    expect((await tamperedRes.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

    // 5. Exact matching key + tool + args consumes permit once and succeeds
    const validRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs, _meta: { approvalId } },
    });
    const validBody = (await validRes.json()) as any;
    expect(validBody.result.structuredContent).toMatchObject({
      deployed: true,
      service: "billing",
      approvalId,
    });

    // 6. Replay with same approvalId is rejected
    const replayRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs, _meta: { approvalId } },
    });
    expect((await replayRes.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

    // 7. Denied approval also cannot execute
    const secondPendingRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs },
    });
    const deniedId = (await secondPendingRes.json() as any).error.data.approvalId as string;
    await h.request(`/admin/approvals/${encodeURIComponent(deniedId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    const postDenyRes = await h.mcp(key1.token, {
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "demo.sensitive_deploy", arguments: deployArgs, _meta: { approvalId: deniedId } },
    });
    expect((await postDenyRes.json() as any).error.data.code).toBe("approval_replay_or_mismatch");
  });

  it("enforces DEMO_MODE upstream lock, 50-key eviction, and 200-row audit cap", async () => {
    const h = createHarness({ DEMO_MODE: "true" });

    // Custom upstream registration blocked in DEMO_MODE
    const upstreamAttempt = await h.request("/admin/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom.api",
        upstreamUrl: "https://mcp.example.com/mcp",
      }),
    });
    expect(upstreamAttempt.status).toBe(403);
    expect(await upstreamAttempt.json()).toMatchObject({ error: "demo_mode_upstream_disabled" });

    // Mint 51 demo keys; oldest key is evicted
    const tokens: string[] = [];
    for (let i = 0; i < 51; i += 1) {
      const res = await h.request("/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `k-${i}`, allowedTools: ["demo.echo"] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { token: string };
      tokens.push(body.token);
    }

    const evictedRes = await h.mcp(tokens[0]!, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(evictedRes.status).toBe(401);

    const newestToken = tokens[50]!;
    const newestRes = await h.mcp(newestToken, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(newestRes.status).toBe(200);

    // Generate > 200 audit events; SQLite audit_events stays capped at 200
    for (let i = 0; i < 210; i += 1) {
      const callRes = await h.mcp(newestToken, {
        jsonrpc: "2.0",
        id: 100 + i,
        method: "tools/call",
        params: { name: "demo.echo", arguments: { message: `msg-${i}` } },
      });
      expect(callRes.status).toBe(200);
    }

    const countRow = h.sql.exec<{ readonly cnt: number }>("SELECT COUNT(*) AS cnt FROM audit_events").toArray()[0]!;
    expect(countRow.cnt).toBe(200);
  });

  it("registers validated HTTPS upstream tools and proxies MCP calls with redirect: manual in self-hosted mode", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    // Rejects SSRF upstream URL
    const ssrfRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "bad.metadata",
        upstreamUrl: "https://169.254.169.254/latest/meta-data/",
      }),
    });
    expect(ssrfRes.status).toBe(400);

    // Rejects invalid schema dialect
    const badSchemaRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "bad.schema",
        upstreamUrl: "https://mcp.example.com/mcp",
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      }),
    });
    expect(badSchemaRes.status).toBe(400);

    // Registers valid HTTPS upstream tool
    const regRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "crm.get_contact",
        description: "Fetch CRM contact",
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        upstreamToolName: "get_contact",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string", minLength: 2 } },
          required: ["id"],
          additionalProperties: false,
        },
      }),
    });
    expect(regRes.status).toBe(201);

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: ["crm.get_contact"] }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "Contact C-42" }],
            structuredContent: { id: "C-42", status: "active" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const callRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(callRes.status).toBe(200);
      expect((await callRes.json() as any).result.structuredContent).toEqual({ id: "C-42", status: "active" });
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("registers declarative upstream request headers, forwards them on tools/call, and never exposes values", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    const secretValue = "upstream-secret-token-value-9f8e";
    const regRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "crm.secure_lookup",
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        upstreamToolName: "secure_lookup",
        headers: {
          Authorization: `Bearer ${secretValue}`,
          "X-Project-Id": "billing-prod",
          Host: "evil.example.com",
          Connection: "keep-alive",
        },
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string", minLength: 1 } },
          required: ["id"],
          additionalProperties: false,
        },
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as { tool: { upstreamHeaderNames: string[] } };
    // Reserved transport/hop-by-hop names are filtered out at registration.
    expect(regBody.tool.upstreamHeaderNames).toEqual(["authorization", "x-project-id"]);

    // Admin state and audit receipts expose header names only — never values.
    const stateRes = await h.request("/admin/state", { headers: adminHeaders });
    const stateText = await stateRes.text();
    expect(stateText).not.toContain(secretValue);
    expect(stateText).toContain("x-project-id");

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: ["crm.secure_lookup"] }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    let capturedHeaders: Headers | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }));
    try {
      const callRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "crm.secure_lookup", arguments: { id: "C-42" } },
      });
      expect(callRes.status).toBe(200);
      const callBody = (await callRes.json()) as { result?: unknown };
      expect(callBody.result).toBeDefined();
      expect(capturedHeaders!.get("authorization")).toBe(`Bearer ${secretValue}`);
      expect(capturedHeaders!.get("x-project-id")).toBe("billing-prod");
      expect(capturedHeaders!.get("host")).toBeNull();
      expect(capturedHeaders!.get("connection")).toBeNull();
      expect(capturedHeaders!.get("content-type")).toBe("application/json");
      expect(capturedHeaders!.get("accept")).toBe("application/json, text/event-stream");
    } finally {
      vi.unstubAllGlobals();
    }

    const postCallState = await h.request("/admin/state", { headers: adminHeaders });
    expect(await postCallState.text()).not.toContain(secretValue);
  });

  it("rejects invalid upstream request headers at registration with upstream_mcp_headers_invalid", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    const invalidHeaderBodies: unknown[] = [
      "not-an-object",
      ["x-a", "b"],
      { "bad name": "v" },
      { "x-ok": 42 },
      { "x-ctl": "line\nbreak" },
      { "x-dup": "1", "X-Dup": "2" },
      Object.fromEntries(Array.from({ length: 65 }, (_v, i) => [`x-h-${i}`, "v"])),
    ];
    for (const headers of invalidHeaderBodies) {
      const res = await h.request("/admin/tools", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          name: "bad.headers",
          upstreamUrl: "https://mcp.example.com/mcp",
          headers,
        }),
      });
      expect(res.status, JSON.stringify(headers)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("upstream_mcp_headers_invalid");
    }
  });

  it("restores a consumed permit when the upstream request provably never left the gateway", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    const regRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "crm.deploy",
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        requiresApproval: true,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { service: { type: "string", minLength: 1 } },
          required: ["service"],
          additionalProperties: false,
        },
      }),
    });
    expect(regRes.status).toBe(201);

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: ["crm.deploy"] }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    const deployArgs = { service: "billing" };
    let callId = 100;
    const approveCall = async () => {
      const res = await h.mcp(token, {
        jsonrpc: "2.0",
        id: callId++,
        method: "tools/call",
        params: { name: "crm.deploy", arguments: deployArgs },
      });
      const body = (await res.json()) as any;
      expect(body.error.data.code).toBe("approval_required");
      const approvalId = body.error.data.approvalId as string;
      const decideRes = await h.request(`/admin/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(decideRes.status).toBe(200);
      return approvalId;
    };
    const callWithApproval = (approvalId: string) =>
      h.mcp(token, {
        jsonrpc: "2.0",
        id: callId++,
        method: "tools/call",
        params: { name: "crm.deploy", arguments: deployArgs, _meta: { approvalId } },
      });
    const approvalRow = (approvalId: string) =>
      h.sql.exec<{ status: string; consumed_at: number | null }>(
        "SELECT status, consumed_at FROM approvals WHERE id = ?",
        approvalId,
      ).toArray()[0]!;

    // Refused redirect: the upstream tool endpoint never ran the call, so the
    // permit is restored to approved and can be redeemed once more.
    const redirectApproval = await approveCall();
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(null, { status: 302, headers: { Location: "https://mcp.example.com/moved" } }),
    ));
    try {
      const refused = await callWithApproval(redirectApproval);
      const refusedBody = (await refused.json()) as any;
      expect(refusedBody.error.data.code).toBe("upstream_redirect_refused");
      expect(refusedBody.error.data.approvalId).toBe(redirectApproval);
      expect(refusedBody.error.data.approvalRestored).toBe(true);
      expect(refusedBody.error.data.resultUnknown).toBeUndefined();
      expect(approvalRow(redirectApproval)).toMatchObject({ status: "approved", consumed_at: null });
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }], structuredContent: { deployed: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    try {
      const reused = await callWithApproval(redirectApproval);
      const reusedBody = (await reused.json()) as any;
      expect(reusedBody.result.structuredContent).toEqual({ deployed: true });
      expect(approvalRow(redirectApproval).status).toBe("consumed");
      const replay = await callWithApproval(redirectApproval);
      expect((await replay.json() as any).error.data.code).toBe("approval_replay_or_mismatch");
    } finally {
      vi.unstubAllGlobals();
    }

    // Synchronous dispatch failure: the request never left the gateway.
    const notSentApproval = await approveCall();
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new TypeError("request construction failed");
    }));
    try {
      const notSent = await callWithApproval(notSentApproval);
      const notSentBody = (await notSent.json()) as any;
      expect(notSentBody.error.data.code).toBe("upstream_request_not_sent");
      expect(notSentBody.error.data.approvalRestored).toBe(true);
      expect(approvalRow(notSentApproval)).toMatchObject({ status: "approved", consumed_at: null });
    } finally {
      vi.unstubAllGlobals();
    }

    // Retire the restored permit so the next bare call opens a fresh approval.
    h.sql.exec("UPDATE approvals SET status = 'denied' WHERE id = ?", notSentApproval);

    // SSRF refusal at dispatch time (upstream_url rewritten to bypass admin validation).
    const ssrfApproval = await approveCall();
    h.sql.exec("UPDATE tools SET upstream_url = ? WHERE name = ?", "http://169.254.169.254/mcp", "crm.deploy");
    const ssrf = await callWithApproval(ssrfApproval);
    const ssrfBody = (await ssrf.json()) as any;
    expect(ssrfBody.error.data.code).toBe("ssrf_https_required");
    expect(ssrfBody.error.data.approvalRestored).toBe(true);
    expect(approvalRow(ssrfApproval)).toMatchObject({ status: "approved", consumed_at: null });
  });

  it("keeps a consumed permit and marks the result unknown when the request may have reached upstream", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "crm.deploy",
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        requiresApproval: true,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { service: { type: "string", minLength: 1 } },
          required: ["service"],
          additionalProperties: false,
        },
      }),
    });

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: ["crm.deploy"] }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    const deployArgs = { service: "billing" };
    let callId = 200;
    const approveCall = async () => {
      const res = await h.mcp(token, {
        jsonrpc: "2.0",
        id: callId++,
        method: "tools/call",
        params: { name: "crm.deploy", arguments: deployArgs },
      });
      const approvalId = ((await res.json()) as any).error.data.approvalId as string;
      await h.request(`/admin/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ decision: "approve" }),
      });
      return approvalId;
    };
    const callWithApproval = (approvalId: string) =>
      h.mcp(token, {
        jsonrpc: "2.0",
        id: callId++,
        method: "tools/call",
        params: { name: "crm.deploy", arguments: deployArgs, _meta: { approvalId } },
      });
    const approvalRow = (approvalId: string) =>
      h.sql.exec<{ status: string; consumed_at: number | null }>(
        "SELECT status, consumed_at FROM approvals WHERE id = ?",
        approvalId,
      ).toArray()[0]!;

    // Transport failure: the request may have reached upstream, so the permit
    // stays consumed and the receipt marks the upstream result as unknown.
    const transportApproval = await approveCall();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    try {
      const failed = await callWithApproval(transportApproval);
      const failedBody = (await failed.json()) as any;
      expect(failedBody.error.data.code).toBe("upstream_transport_failed");
      expect(failedBody.error.data.approvalId).toBe(transportApproval);
      expect(failedBody.error.data.resultUnknown).toBe(true);
      expect(failedBody.error.data.approvalRestored).toBeUndefined();
      expect(approvalRow(transportApproval).status).toBe("consumed");
      const replay = await callWithApproval(transportApproval);
      expect((await replay.json() as any).error.data.code).toBe("approval_replay_or_mismatch");
    } finally {
      vi.unstubAllGlobals();
    }

    // An upstream HTTP error proves arrival: the permit stays consumed without
    // an unknown-result marker.
    const httpErrorApproval = await approveCall();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    try {
      const httpError = await callWithApproval(httpErrorApproval);
      const httpErrorBody = (await httpError.json()) as any;
      expect(httpErrorBody.error.data.code).toBe("upstream_http_error");
      expect(httpErrorBody.error.data.resultUnknown).toBeUndefined();
      expect(approvalRow(httpErrorApproval).status).toBe("consumed");
      const replay = await callWithApproval(httpErrorApproval);
      expect((await replay.json() as any).error.data.code).toBe("approval_replay_or_mismatch");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns upstream_redirect_refused to the client when the upstream answers 302", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    const regRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "crm.get_contact",
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
      }),
    });
    expect(regRes.status).toBe(201);

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: ["crm.get_contact"] }),
    });
    const { token } = (await keyRes.json()) as { token: string };

    const fetchStub = vi.fn(async () =>
      new Response("redirected secret", {
        status: 302,
        headers: { Location: "https://mcp.example.com/moved" },
      }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      const callRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(callRes.status).toBe(200);
      const payload = (await callRes.json()) as any;
      expect(payload.result).toBeUndefined();
      expect(payload.error?.data?.code).toBe("upstream_redirect_refused");
      expect(JSON.stringify(payload)).not.toContain("redirected secret");
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function createStatefulUpstreamStub(options: { expireSessionsAfterHandshake?: boolean } = {}) {
    const sessions = new Set<string>();
    let sessionCounter = 0;
    const calls: Array<{ method: string | undefined; sessionId: string | null; protocolVersion: string | null }> = [];

    const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const normalized: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v;
      const sessionId = normalized["mcp-session-id"] ?? null;
      const protocolVersion = normalized["mcp-protocol-version"] ?? null;
      const payload = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method?: string };
      calls.push({ method: payload.method, sessionId, protocolVersion });

      const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...extraHeaders },
        });

      if (payload.method === "initialize") {
        if (sessionId) return json(404, { error: "unknown session" });
        sessionCounter += 1;
        const sid = `sess-${sessionCounter}`;
        sessions.add(sid);
        return json(
          200,
          {
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stateful-fixture", version: "1.0.0" },
            },
          },
          { "Mcp-Session-Id": sid },
        );
      }

      if (payload.method === "notifications/initialized") {
        if (!sessionId || !sessions.has(sessionId)) return json(404, { error: "unknown session" });
        if (options.expireSessionsAfterHandshake) sessions.delete(sessionId);
        return new Response(null, { status: 202 });
      }

      if (!sessionId) {
        return json(400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Server not initialized" },
          id: null,
        });
      }
      if (!sessions.has(sessionId)) return json(404, { error: "unknown session" });
      return json(200, {
        jsonrpc: "2.0",
        id: payload.id ?? 1,
        result: {
          content: [{ type: "text", text: "Contact C-42" }],
          structuredContent: { id: "C-42", status: "active" },
        },
      });
    });

    return { fetchStub, calls, sessions };
  }

  async function registerUpstreamTool(
    h: ReturnType<typeof createHarness>,
    adminHeaders: Record<string, string>,
    name = "crm.get_contact",
  ) {
    const regRes = await h.request("/admin/tools", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name,
        upstreamUrl: "https://mcp.example.com:8443/mcp",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
      }),
    });
    expect(regRes.status).toBe(201);

    const keyRes = await h.request("/admin/keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "crm-agent", allowedTools: [name] }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    return { token };
  }

  it("handshakes on demand with stateful upstreams, carries the session id, and reuses it", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const { token } = await registerUpstreamTool(h, adminHeaders);

    const upstream = createStatefulUpstreamStub();
    vi.stubGlobal("fetch", upstream.fetchStub);
    try {
      const firstRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(firstRes.status).toBe(200);
      expect((await firstRes.json() as any).result.structuredContent).toEqual({ id: "C-42", status: "active" });

      // Stateless probe, initialize handshake, initialized notification, retried call.
      expect(upstream.calls.map((c) => c.method)).toEqual([
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      expect(upstream.calls[0]!.sessionId).toBeNull();
      expect(upstream.calls[3]!.sessionId).toBe("sess-1");
      expect(upstream.calls[3]!.protocolVersion).toBe("2025-06-18");

      // Second call reuses the established session without another handshake.
      const secondRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(secondRes.status).toBe(200);
      expect((await secondRes.json() as any).result.structuredContent.id).toBe("C-42");
      expect(upstream.calls).toHaveLength(5);
      expect(upstream.calls[4]).toMatchObject({ method: "tools/call", sessionId: "sess-1" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-handshakes exactly once after the upstream invalidates the session", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const { token } = await registerUpstreamTool(h, adminHeaders);

    const upstream = createStatefulUpstreamStub();
    vi.stubGlobal("fetch", upstream.fetchStub);
    try {
      const firstRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(firstRes.status).toBe(200);
      expect(upstream.calls).toHaveLength(4);

      // Upstream forgets every known session (e.g., process restart).
      upstream.sessions.clear();

      const secondRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(secondRes.status).toBe(200);
      expect((await secondRes.json() as any).result.structuredContent.id).toBe("C-42");
      expect(upstream.calls.map((c) => c.method)).toEqual([
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      expect(upstream.calls[7]!.sessionId).toBe("sess-2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns upstream_handshake_failed when the stateful upstream rejects initialize", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const { token } = await registerUpstreamTool(h, adminHeaders);

    const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (payload.method === "initialize") {
        return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "boom" }, id: null });
      }
      return json(400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Server not initialized" },
        id: null,
      });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const callRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(callRes.status).toBe(200);
      const payload = (await callRes.json()) as any;
      expect(payload.result).toBeUndefined();
      expect(payload.error?.data?.code).toBe("upstream_handshake_failed");
      expect(fetchStub.mock.calls.map((c) => (JSON.parse(String(c[1]?.body)) as { method?: string }).method)).toEqual([
        "tools/call",
        "initialize",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns upstream_session_expired when re-handshake still fails to hold a session", async () => {
    const adminToken = "self-hosted-operator-secret";
    const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: adminToken });
    const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` };
    const { token } = await registerUpstreamTool(h, adminHeaders);

    const upstream = createStatefulUpstreamStub({ expireSessionsAfterHandshake: true });
    vi.stubGlobal("fetch", upstream.fetchStub);
    try {
      const callRes = await h.mcp(token, {
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: { name: "crm.get_contact", arguments: { id: "C-42" } },
      });
      expect(callRes.status).toBe(200);
      const payload = (await callRes.json()) as any;
      expect(payload.result).toBeUndefined();
      expect(payload.error?.data?.code).toBe("upstream_session_expired");
      expect(upstream.calls.map((c) => c.method)).toEqual([
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
