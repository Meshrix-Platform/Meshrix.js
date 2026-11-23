import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.ts";
import { MeshrixGatewayDO, type GatewayEnv } from "../src/gateway-do.ts";
import {
  buildApprovalRequest,
  derToP1363,
  evaluateConclusion,
  jcsCanonicalize,
  parsePairCode,
  pubkeyFingerprint,
  requestDigest,
  validateApproverPubkey,
  validateRelayBaseUrl,
} from "../src/entio.ts";

// Compatibility vectors from the Entio repo's docs/vectors/entio-v2.json.
// The P-256 key below is that file's synthetic TEST-ONLY pair; it is not a
// real device key and is never usable on a real pairing.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "2xEQmiTYcY5iVFSlb2MolB0CVjwfR9nzHGu3eDBhi-k",
  y: "yUPdJW7aRICOHsC8A8Js4kf1NATNGVWM8y6b0UTrD2E",
  d: "VlzTBK_GoTXrObsc4w0DzEj_voTXaVzbiXIZQxjilcM",
} as const;
const TEST_PUBKEY_B64 =
  "BNsREJok2HGOYlRUpW9jKJQdAlY8H0fZ8xxrt3gwYYvpyUPdJW7aRICOHsC8A8Js4kf1NATNGVWM8y6b0UTrD2E=";

const VECTOR = {
  request: {
    v: 2,
    type: "approval",
    source: { system: "gitvault", instance: "workstation" },
    pair: "11111111-2222-3333-4444-555555555555",
    nonce: "0123456789abcdeffedcba9876543210",
    issued_at: 1764000000000,
    expires_at: 1764000300000,
    summary: "批准将 3 个提交推送到 GitVault main",
    fields: {
      action: "git.push",
      target: "GitVault:main",
      commits: "3",
      remote: "git.example.test/GitVault",
    },
  },
  requestCanonical:
    '{"expires_at":1764000300000,"fields":{"action":"git.push","commits":"3","remote":"git.example.test/GitVault","target":"GitVault:main"},"issued_at":1764000000000,"nonce":"0123456789abcdeffedcba9876543210","pair":"11111111-2222-3333-4444-555555555555","source":{"instance":"workstation","system":"gitvault"},"summary":"批准将 3 个提交推送到 GitVault main","type":"approval","v":2}',
  requestDigest: "oHQJ19UbbbMvFyu5_XgmHL2upjM1y-ylWhrLGSGs30c",
  signedApproval:
    'entio:v2\u0000{"decided_at":1764000060000,"decision":"approved","expires_at":1764000300000,"pair":"11111111-2222-3333-4444-555555555555","request_digest":"oHQJ19UbbbMvFyu5_XgmHL2upjM1y-ylWhrLGSGs30c","v":2}',
  approvalConclusion: {
    v: 2,
    pair: "11111111-2222-3333-4444-555555555555",
    request_digest: "oHQJ19UbbbMvFyu5_XgmHL2upjM1y-ylWhrLGSGs30c",
    expires_at: 1764000300000,
    decision: "approved",
    decided_at: 1764000060000,
    signature:
      "MEUCIBdOnkX6Euk6DznjxEFouhO7aYSlM+D8PEu23oZqIAPhAiEA1FHaAkH1lIe6dWVnRyu7PhGHQNlAJfbV5A9IEWLL22Y=",
    pubkey: TEST_PUBKEY_B64,
  },
  rejectionConclusion: {
    v: 2,
    pair: "11111111-2222-3333-4444-555555555555",
    request_digest: "oHQJ19UbbbMvFyu5_XgmHL2upjM1y-ylWhrLGSGs30c",
    expires_at: 1764000300000,
    decision: "rejected",
    decided_at: 1764000060000,
    signature:
      "MEUCIQDEZ8+biNg2hDpz6s9ZPPk6L+bXXXGzofVU0Kry/IBjOwIgQ1Pjehx7ETmr71GFyO+bGGwL3JkvSJ+MiMZ8m1F00l4=",
    pubkey: TEST_PUBKEY_B64,
  },
  swappedRequest: {
    v: 2,
    type: "approval",
    source: { system: "gitvault", instance: "workstation" },
    pair: "11111111-2222-3333-4444-555555555555",
    nonce: "0123456789abcdeffedcba9876543210",
    issued_at: 1764000000000,
    expires_at: 1764000300000,
    summary: "批准将 3 个提交推送到 GitVault production",
    fields: {
      action: "git.push",
      target: "GitVault:production",
      commits: "3",
      remote: "git.example.test/GitVault",
    },
  },
  swappedConclusionSignature:
    "MEQCIAtIV0REPFCFrEdN1rdf6qkjrijTYPItJdb1/t7xeMHiAiAnp6DXGkYjVGA0JUCNPo6UcIiLookjmBO4Uyn0+3/mTw==",
  expiredConclusionSignature:
    "MEUCIQC6jtPWjrt7FX3Zh4DKmubdec7n8Ghva62che3d6aMFSgIgcc5XcMk0lvIjYPf8n477IzpNYCX+oGe3QY7NKPcRUvw=",
} as const;

const PAIR_ID = "99999999-8888-7777-6666-555555555555";
const RELAY_ORIGIN = "https://relay.example.test";
const UPSTREAM_URL = "https://mcp.example.com:8443/mcp";

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
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
    }
    if (/\bRETURNING\b/iu.test(trimmed)) {
      const rows = stmt.all(...(bindings as never[])) as T[];
      return { toArray: () => rows, rowsRead: 0, rowsWritten: rows.length };
    }
    const res = stmt.run(...(bindings as never[]));
    return { toArray: () => [] as T[], rowsRead: 0, rowsWritten: Number(res.changes ?? 0) };
  }
}

function createHarness(envOverrides: Partial<GatewayEnv> = {}) {
  const sql = new InMemorySqlStorage();
  const state = {
    storage: { sql },
    blockConcurrencyWhile: async <T>(cb: () => Promise<T>) => cb(),
  } as unknown as DurableObjectState;

  let gatewayDo: MeshrixGatewayDO | null = null;
  const env: GatewayEnv = {
    DEMO_MODE: envOverrides.DEMO_MODE ?? "false",
    ADMIN_TOKEN: envOverrides.ADMIN_TOKEN,
    ADMIN_DECIDE_ENABLED: envOverrides.ADMIN_DECIDE_ENABLED,
    ENTIO_INSTANCE: envOverrides.ENTIO_INSTANCE,
    GATEWAY: {
      idFromName: (name: string) => ({ toString: () => `do:${name}` }) as DurableObjectId,
      get: () => {
        if (!gatewayDo) gatewayDo = new MeshrixGatewayDO(state, env);
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

  const mcp = (token: string | null, payload: unknown) =>
    request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });

  return { env, sql, request, mcp };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64DecodeStrict(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function p1363ToDer(raw: Uint8Array): Uint8Array {
  const encodeInt = (input: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < input.length - 1 && input[start] === 0 && (input[start + 1]! & 0x80) === 0) start += 1;
    let body = input.slice(start);
    if (body[0]! & 0x80) body = Uint8Array.from([0, ...body]);
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const r = encodeInt(raw.slice(0, 32));
  const s = encodeInt(raw.slice(32, 64));
  const seq = Uint8Array.from([...r, ...s]);
  return Uint8Array.from([0x30, seq.length, ...seq]);
}

async function signConclusion(
  request: Record<string, unknown>,
  decision: "approved" | "rejected",
  overrides: { decidedAt?: number; expiresAt?: number; digest?: string } = {},
): Promise<Record<string, unknown>> {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const core: Record<string, unknown> = {
    v: 2,
    pair: request.pair,
    request_digest: overrides.digest ?? (await requestDigest(request)),
    expires_at: overrides.expiresAt ?? request.expires_at,
    decision,
    decided_at: overrides.decidedAt ?? Date.now(),
  };
  const message = new TextEncoder().encode(`entio:v2\0${jcsCanonicalize(core)}`);
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message as BufferSource),
  );
  return { ...core, signature: base64Encode(p1363ToDer(rawSig)), pubkey: TEST_PUBKEY_B64 };
}

interface FakeRelay {
  readonly dispatched: Record<string, unknown>[];
  readonly conclusions: Map<string, Record<string, unknown>>;
  post(request: Record<string, unknown>, conclusion: Record<string, unknown>): void;
}

function createFakeRelay(): { relay: FakeRelay; fetchStub: ReturnType<typeof vi.fn> } {
  let counter = 0;
  const dispatched: Record<string, unknown>[] = [];
  const conclusions = new Map<string, Record<string, unknown>>();
  const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith(RELAY_ORIGIN)) {
      const u = new URL(url);
      if (init?.method === "POST" && u.pathname === `/pair/${PAIR_ID}/requests`) {
        counter += 1;
        const rid = `rid-${counter}`;
        dispatched.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ request_id: rid }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === undefined || init.method === "GET") {
        if (u.pathname === `/pair/${PAIR_ID}/result`) {
          const rid = u.searchParams.get("request") ?? "";
          const conclusion = conclusions.get(rid);
          if (!conclusion) {
            return new Response(JSON.stringify({ state: "pending" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          const state = (conclusion as { decision?: string }).decision === "rejected" ? "rejected" : "approved";
          return new Response(JSON.stringify({ state, conclusion }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      if (init?.method === "POST" && u.pathname === `/pair/${PAIR_ID}/cancel`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    if (url === UPSTREAM_URL) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "deployed" }],
            structuredContent: { deployed: true },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected fetch", { status: 500 });
  });
  const relay: FakeRelay = {
    dispatched,
    conclusions,
    post(_request, conclusion) {
      conclusions.set(`rid-${counter}`, conclusion);
    },
  };
  return { relay, fetchStub };
}

const ADMIN_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer self-hosted-operator-secret",
};

async function setupApprovalFixture(envOverrides: Partial<GatewayEnv> = {}) {
  const h = createHarness({ DEMO_MODE: "false", ADMIN_TOKEN: "self-hosted-operator-secret", ...envOverrides });
  const pairRes = await h.request("/admin/entio/pairings", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      label: "ops-phone",
      relay: RELAY_ORIGIN,
      pair: PAIR_ID,
      secret: "test-pairing-secret-aaaa-bbbb",
      pubkey: TEST_PUBKEY_B64,
    }),
  });
  expect(pairRes.status).toBe(201);

  const regRes = await h.request("/admin/tools", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      name: "crm.deploy",
      upstreamUrl: UPSTREAM_URL,
      requiresApproval: true,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"],
        additionalProperties: false,
      },
    }),
  });
  expect(regRes.status).toBe(201);

  const keyRes = await h.request("/admin/keys", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name: "agent", allowedTools: ["crm.deploy"] }),
  });
  const { token } = (await keyRes.json()) as { token: string };
  return { h, token };
}

const CALL_ARGS = { service: "billing" };

async function mcpCall(
  token: string,
  mcp: (t: string, p: unknown) => Response | Promise<Response>,
  args: Record<string, unknown>,
  approvalId?: string,
) {
  return mcp(token, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e6),
    method: "tools/call",
    params: {
      name: "crm.deploy",
      arguments: args,
      ...(approvalId ? { _meta: { approvalId } } : {}),
    },
  });
}

async function issueCall(token: string, mcp: (t: string, p: unknown) => Response | Promise<Response>, approvalId?: string) {
  return mcpCall(token, mcp, CALL_ARGS, approvalId);
}

describe("Entio v2 protocol module", () => {
  it("canonicalizes requests exactly as the shared vectors (integer-only RFC 8785 JCS)", () => {
    expect(jcsCanonicalize(VECTOR.request)).toBe(VECTOR.requestCanonical);
    expect(() => jcsCanonicalize({ a: 1.5 })).toThrowError();
    expect(() => jcsCanonicalize({ a: 2 ** 60 })).toThrowError();
  });

  it("reproduces the official request digest and DER signature shape", async () => {
    expect(await requestDigest(VECTOR.request)).toBe(VECTOR.requestDigest);
    const raw = derToP1363(base64DecodeStrict(VECTOR.approvalConclusion.signature));
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(64);
    expect(raw!.some((b) => b !== 0)).toBe(true);
  });

  it("evaluates official vector conclusions: approved, rejected, swapped, expired, tampered", async () => {
    const approved = await evaluateConclusion(
      VECTOR.request,
      VECTOR.approvalConclusion,
      1764000090000,
      TEST_PUBKEY_B64,
    );
    expect(approved.kind).toBe("approved");

    const rejected = await evaluateConclusion(
      VECTOR.request,
      VECTOR.rejectionConclusion,
      1764000090000,
      TEST_PUBKEY_B64,
    );
    expect(rejected.kind).toBe("rejected");

    const swapped = await evaluateConclusion(
      VECTOR.swappedRequest,
      { ...VECTOR.approvalConclusion, signature: VECTOR.swappedConclusionSignature },
      1764000090000,
      TEST_PUBKEY_B64,
    );
    expect(swapped).toMatchObject({ kind: "invalid", reason: "conclusion digest does not match the request" });

    const expired = await evaluateConclusion(
      VECTOR.request,
      { ...VECTOR.approvalConclusion, signature: VECTOR.expiredConclusionSignature },
      1764000300001,
      TEST_PUBKEY_B64,
    );
    expect(expired).toMatchObject({ kind: "invalid", reason: "decision window has closed" });

    const tampered = await evaluateConclusion(
      VECTOR.request,
      { ...VECTOR.approvalConclusion, decision: "rejected" },
      1764000090000,
      TEST_PUBKEY_B64,
    );
    expect(tampered).toMatchObject({ kind: "invalid", reason: "signature does not verify" });
  });

  it("rejects an unpinned device key and malformed signatures", async () => {
    const otherPub =
      "BEe0vQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8=";
    const unpinned = await evaluateConclusion(
      VECTOR.request,
      VECTOR.approvalConclusion,
      1764000090000,
      otherPub,
    );
    expect(unpinned).toMatchObject({ kind: "invalid", reason: "conclusion signed by an unpinned device key" });

    const badSig = await evaluateConclusion(
      VECTOR.request,
      { ...VECTOR.approvalConclusion, signature: "not-base64!!" },
      1764000090000,
      TEST_PUBKEY_B64,
    );
    expect(badSig).toMatchObject({ kind: "invalid", reason: "signature is not base64" });
  });

  it("validates pair codes, relay URLs, approver keys, and fingerprints", async () => {
    const code = `entio://pair?i=${PAIR_ID}&s=sekret&r=${encodeURIComponent("https://relay.example.test")}`;
    expect(parsePairCode(code)).toEqual({
      pair: PAIR_ID,
      secret: "sekret",
      relay: "https://relay.example.test",
    });
    expect(parsePairCode("entio://pair?i=not-a-uuid&s=x")).toBeNull();
    expect(parsePairCode("https://pair?i=x&s=y")).toBeNull();

    expect(validateRelayBaseUrl("https://relay.example.test/base/path")).toBe("https://relay.example.test");
    expect(() => validateRelayBaseUrl("https://169.254.169.254/")).toThrowError();
    expect(() => validateRelayBaseUrl("https://relay.example.test:9000/")).toThrowError();
    expect(validateRelayBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");

    expect(await validateApproverPubkey(TEST_PUBKEY_B64)).toBe(true);
    expect(await validateApproverPubkey("AAAA")).toBe(false);
    expect(await pubkeyFingerprint(TEST_PUBKEY_B64)).toMatch(/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/u);
  });

  it("builds a content-bound gateway approval request", async () => {
    const request = buildApprovalRequest({
      pair: PAIR_ID,
      instance: "meshrix-mcp-gateway",
      approvalId: "apr_1",
      keyId: "key_1",
      keyName: "agent",
      toolName: "crm.deploy",
      argsSha256: "f".repeat(64),
      issuedAt: 1000,
      expiresAt: 1000 + 30 * 60 * 1000,
      nonce: "n".repeat(24),
    });
    expect(request.v).toBe(2);
    expect(request.type).toBe("approval");
    expect(request.pair).toBe(PAIR_ID);
    const fields = request.fields as Record<string, string>;
    expect(fields.action).toBe("mcp.tools/call");
    expect(fields.target).toBe("crm.deploy");
    expect(fields.key_id).toBe("key_1");
    expect(fields.args_sha256).toBe("f".repeat(64));
    expect(fields.approval).toBe("apr_1");
    expect(await requestDigest(request)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe("Gateway Entio-signed approvals", () => {
  it("runs dispatch → phone sign → execute → report end to end", async () => {
    const { h, token } = await setupApprovalFixture();
    const { relay, fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      // 1. Initial call: pending permit + bound request pushed to the relay.
      const first = await issueCall(token, h.mcp);
      const firstBody = (await first.json()) as any;
      expect(firstBody.error.data.code).toBe("approval_required");
      const approvalId = firstBody.error.data.approvalId as string;

      expect(relay.dispatched.length).toBe(1);
      const dispatched = relay.dispatched[0]!;
      expect(dispatched.v).toBe(2);
      expect(dispatched.pair).toBe(PAIR_ID);
      const fields = dispatched.fields as Record<string, string>;
      expect(fields.target).toBe("crm.deploy");
      expect(fields.key).toBe("agent");
      expect(fields.approval).toBe(approvalId);

      // 2. Phone signs an approval conclusion; the next call picks it up.
      relay.post(dispatched, await signConclusion(dispatched, "approved"));
      const second = await issueCall(token, h.mcp, approvalId);
      const secondBody = (await second.json()) as any;
      expect(secondBody.result?.structuredContent).toMatchObject({ deployed: true });

      // 3. The permit is consumed — replay is refused.
      const replay = await issueCall(token, h.mcp, approvalId);
      expect((await replay.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

      const state = (await (await h.request("/admin/state", { headers: ADMIN_HEADERS })).json()) as any;
      const settled = state.approvals.find((a: any) => a.id === approvalId);
      expect(settled.status).toBe("consumed");
      expect(settled.decisionReason).toBe("entio:ops-phone");
      expect(state.entio.requests.some((r: any) => r.status === "concluded" && r.decision === "approved")).toBe(true);
      // The pairing secret is never exposed.
      expect(JSON.stringify(state.entio)).not.toContain("test-pairing-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a signed rejection denies execution; retry stays blocked", async () => {
    const { h, token } = await setupApprovalFixture();
    const { relay, fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const first = await issueCall(token, h.mcp);
      const approvalId = ((await first.json()) as any).error.data.approvalId as string;
      relay.post(relay.dispatched[0]!, await signConclusion(relay.dispatched[0]!, "rejected"));

      const second = await issueCall(token, h.mcp, approvalId);
      expect((await second.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

      const state = (await (await h.request("/admin/state", { headers: ADMIN_HEADERS })).json()) as any;
      const settled = state.approvals.find((a: any) => a.id === approvalId);
      expect(settled.status).toBe("denied");
      expect(settled.decisionReason).toBe("entio:ops-phone:rejected");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an invalidly signed conclusion never releases the permit", async () => {
    const { h, token } = await setupApprovalFixture();
    const { relay, fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const first = await issueCall(token, h.mcp);
      const approvalId = ((await first.json()) as any).error.data.approvalId as string;
      const dispatched = relay.dispatched[0]!;

      const forged = await signConclusion(dispatched, "approved");
      (forged as { signature: string }).signature = base64Encode(
        p1363ToDer(new Uint8Array(64).fill(7)),
      );
      relay.post(dispatched, forged);

      // Explicit-id retry while the permit is still pending gets the standard
      // mismatch surface; the forged conclusion never releases it.
      const second = await issueCall(token, h.mcp, approvalId);
      expect((await second.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

      // A fresh call finds the same live permit and re-reports it.
      const third = await issueCall(token, h.mcp);
      const thirdBody = (await third.json()) as any;
      expect(thirdBody.error.data.code).toBe("approval_required");
      expect(thirdBody.error.data.approvalId).toBe(approvalId);

      const state = (await (await h.request("/admin/state", { headers: ADMIN_HEADERS })).json()) as any;
      expect(state.entio.requests.some((r: any) => r.status === "invalid")).toBe(true);
      const stillPending = state.approvals.find((a: any) => a.id === approvalId);
      expect(stillPending.status).toBe("pending");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a conclusion bound to different content or an expired window is rejected", async () => {
    const { h, token } = await setupApprovalFixture();
    const { relay, fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const first = await issueCall(token, h.mcp);
      const approvalId = ((await first.json()) as any).error.data.approvalId as string;
      const dispatched = relay.dispatched[0]!;

      // Content binding: sign over the digest of a different request.
      const otherRequest = { ...dispatched, nonce: "different-nonce-for-mismatch-test" };
      const mismatched = await signConclusion(dispatched, "approved", {
        digest: await requestDigest(otherRequest),
      });
      relay.post(dispatched, mismatched);
      const second = await issueCall(token, h.mcp, approvalId);
      expect((await second.json() as any).error.data.code).toBe("approval_replay_or_mismatch");

      // Expired window: a second approval gets a dispatch whose conclusion is
      // signed with decided_at strictly after expires_at.
      const third = await mcpCall(token, h.mcp, { service: "billing-expiry" });
      const thirdApprovalId = ((await third.json()) as any).error.data.approvalId as string;
      expect(thirdApprovalId).toMatch(/^apr_/u);
      expect(thirdApprovalId).not.toBe(approvalId);
      const secondDispatch = relay.dispatched[1]!;
      const expired = await signConclusion(secondDispatch, "approved", {
        decidedAt: Number(secondDispatch.expires_at) + 1,
      });
      relay.post(secondDispatch, expired);
      const fourth = await mcpCall(token, h.mcp, { service: "billing-expiry" }, thirdApprovalId);
      const fourthBody = (await fourth.json()) as any;
      expect(fourthBody.error.data.code).toBe("approval_replay_or_mismatch");

      const state = (await (await h.request("/admin/state", { headers: ADMIN_HEADERS })).json()) as any;
      const reasons = state.entio.requests.map((r: any) => r.detail).filter(Boolean) as string[];
      expect(reasons).toContain("conclusion digest does not match the request");
      expect(reasons).toContain("decision window has closed");
      expect(state.approvals.find((a: any) => a.id === approvalId).status).toBe("pending");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ADMIN_DECIDE_ENABLED=false closes the admin-token fallback", async () => {
    const { h, token } = await setupApprovalFixture({ ADMIN_DECIDE_ENABLED: "false" });
    const { fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const first = await issueCall(token, h.mcp);
      const approvalId = ((await first.json()) as any).error.data.approvalId as string;
      const decide = await h.request(`/admin/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(decide.status).toBe(403);
      expect(await decide.json()).toMatchObject({ error: "admin_decide_disabled" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("admin-token decide still works when enabled, alongside Entio", async () => {
    const { h, token } = await setupApprovalFixture();
    const { fetchStub } = createFakeRelay();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const first = await issueCall(token, h.mcp);
      const approvalId = ((await first.json()) as any).error.data.approvalId as string;
      const decide = await h.request(`/admin/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ decision: "approve", reason: "operator override" }),
      });
      expect(decide.status).toBe(200);
      const second = await issueCall(token, h.mcp, approvalId);
      expect(((await second.json()) as any).result?.structuredContent).toMatchObject({ deployed: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses pairing management in demo mode and rejects bad pairing input", async () => {
    const demo = createHarness({ DEMO_MODE: "true" });
    const demoRes = await demo.request("/admin/entio/pairings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x", relay: RELAY_ORIGIN, pair: PAIR_ID, secret: "s", pubkey: TEST_PUBKEY_B64 }),
    });
    expect(demoRes.status).toBe(403);
    expect(await demoRes.json()).toMatchObject({ error: "entio_unavailable" });

    const { h } = await setupApprovalFixture();
    for (const bad of [
      { label: "bad label!", relay: RELAY_ORIGIN, pair: PAIR_ID, secret: "s", pubkey: TEST_PUBKEY_B64 },
      { label: "ok", relay: "https://169.254.169.254/", pair: PAIR_ID, secret: "s", pubkey: TEST_PUBKEY_B64 },
      { label: "ok", relay: RELAY_ORIGIN, pair: "not-a-uuid", secret: "s", pubkey: TEST_PUBKEY_B64 },
      { label: "ok", relay: RELAY_ORIGIN, pair: PAIR_ID, secret: "s", pubkey: "AAAA" },
    ]) {
      const res = await h.request("/admin/entio/pairings", {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });
});
