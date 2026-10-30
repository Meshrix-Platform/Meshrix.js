import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { validateUpstreamContentPolicy } from "../../../packages/contracts/src/upstream-service-publishing.ts";
const canned1 = "run";
const canned2 = "sk-live-1";
const canned3 = "opaque-ref";
const canned4 = "tools/call";
const canned5 = "s3cr3t";




const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: {
    id: "grant",
    subjectId: "operator",
    dynamicCapabilities: ["cap:upstream:guarded:run"]
  },
  scopes: ["gateway:read", "gateway:write"],
  dynamicCapabilities: ["cap:upstream:guarded:run"]
};

function httpService(overrides: Record<string, any> = {}, operationOverrides: Record<string, any> = {}) : any {
  return structuredUpstreamServiceFixture({
    serviceId: "guarded",
    serviceProtocol: "http",
    label: "guarded",
    allowLocalNetwork: true,
    operations: [{
      operationKey: canned1,
      method: "POST",
      path: "/run",
      risk: "read_only",
      requiredScopes: ["gateway:write"],
      ...operationOverrides
    }],
    ...overrides
  });
}

function registryWithCounters() : any {
  const counters = { claims: 0 };
  const registry = createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    claimProtectedSinkAttempt: async () => {
      counters.claims += 1;
      return Object.freeze({ id: `claim-${counters.claims}`, consumed: true });
    }
  });
  return { registry, counters };
}

async function jsonPeer(handler: (body: any) => any) : Promise<any> {
  const hits = { count: 0 };
  const peer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    hits.count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic upstream peer is unavailable.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => peer.close(() => resolve()))
  };
}

describe("Upstream request content policy", () => {
  it("denies a structured call on a whole-payload deny rule without touching upstream or permits", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const { registry, counters } = registryWithCounters();
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url }, {
      contentPolicy: {
        request: { rules: [{ id: "block-key-material", deny: { contains: ["-----BEGIN"] } }] }
      }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { pem: ["-----BEGIN", "PRIVATE KEY-----"].join(" "), note: "x" } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      expect(peer.hits.count).toBe(0);
      expect(counters.claims).toBe(0);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("evaluates path-selected deny and allow rules, then forwards an admitted call", async () => {
    const peer = await jsonPeer((body) => ({ echoed: body }));
    const { registry, counters } = registryWithCounters();
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url }, {
      contentPolicy: {
        request: {
          rules: [
            { id: "block-raw-token", path: "body.token", deny: { matches: ["^sk-[A-Za-z0-9-]+$"] } },
            { id: "allow-read-verbs", path: "body.verb", allow: { oneOf: ["read", "list"] } }
          ]
        }
      }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { verb: "read", token: canned2 } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { verb: "delete" } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      const admitted = await registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { verb: "list", token: canned3 } },
        SUBJECT
      );
      expect(peer.hits.count).toBe(1);
      expect(counters.claims).toBe(1);
      expect(admitted?.response?.json?.echoed?.verb).toBe("list");
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("fails closed when an allow rule's path is absent", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const { registry, counters } = registryWithCounters();
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url }, {
      contentPolicy: {
        request: { rules: [{ id: "require-command", path: "body.command", allow: { oneOf: ["status"] } }] }
      }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { other: true } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      expect(peer.hits.count).toBe(0);
      expect(counters.claims).toBe(0);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("merges service-level rules into the operation dispatch path", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const { registry, counters } = registryWithCounters();
    installUpstreamRuntimeServices(registry, [structuredUpstreamServiceFixture({
      serviceId: "guarded",
      serviceProtocol: "http",
      allowLocalNetwork: true,
      baseUrl: peer.url,
      contentPolicy: {
        request: { rules: [{ id: "svc-block-debug", path: "body.mode", deny: { oneOf: ["debug"] } }] }
      },
      operations: [{
        operationKey: canned1,
        method: "POST",
        path: "/run",
        risk: "read_only",
        requiredScopes: ["gateway:write"]
      }]
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { mode: "debug" } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      expect(peer.hits.count).toBe(0);
      expect(counters.claims).toBe(0);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("denies MCP tools/call through service-level policy before any upstream session work", async () => {
    let invocations = 0;
    let claims = 0;
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      mcpSessionManager: {
        listTools: async () => ({ tools: [{ name: "store", inputSchema: { type: "object" } }] }),
        invokeGateway: async () => { invocations += 1; return { result: { content: [] } }; },
        retireScope: async () => ({ retired: 0 }),
        close: async () => {}
      },
      claimProtectedSinkAttempt: async () => {
        claims += 1;
        return Object.freeze({ id: `claim-${claims}`, consumed: true });
      }
    });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "vault",
      serviceProtocol: "mcp",
      label: "vault",
      allowLocalNetwork: true,
      contentPolicy: {
        request: { rules: [{ id: "block-creds", path: "arguments.secret", deny: { matches: [".+"] } }] }
      },
      operations: [{ operationKey: canned4, protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
      mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", protocolVersion: "2025-06-18" }
    }]);
    const subject = {
      type: "tool-grant",
      subjectId: "operator",
      grantId: "grant",
      grant: { id: "grant", subjectId: "operator", dynamicCapabilities: ["cap:upstream:vault:tools-call-store"] },
      scopes: ["gateway:read"],
      dynamicCapabilities: ["cap:upstream:vault:tools-call-store"]
    };
    try {
      await expect(registry.forward(
        { serviceId: "vault", operationKey: canned4, toolName: "store", arguments: { secret: canned5 } },
        subject
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      expect(invocations).toBe(0);
      expect(claims).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it("rejects malformed policies at the publishing boundary", () => {
    expect(() => validateUpstreamContentPolicy({ request: { rules: [{ id: "bad", deny: { matches: ["["] } }] } }))
      .toThrow(/does not compile/u);
    expect(() => validateUpstreamContentPolicy({ request: { rules: [{ id: "open", allow: { oneOf: ["a"] } }] } }))
      .toThrow(/requires a path/u);
    expect(() => validateUpstreamContentPolicy({ request: { rules: [{ id: "both", deny: { contains: ["x"] }, allow: { oneOf: ["x"] } }] } }))
      .toThrow(/exactly one/u);
    expect(() => validateUpstreamContentPolicy({ request: { rules: [{ id: "x", deny: { contains: ["x"] }, extra: true }] } }))
      .toThrow(/Unknown/u);
    expect(() => validateUpstreamContentPolicy({ response: { rules: [] } }))
      .toThrow(/Unknown descriptor\.contentPolicy|Unknown contentPolicy|request policy/u);
    expect(() => validateUpstreamContentPolicy(
      { request: { rules: [{ id: "x", path: "__proto__.polluted", deny: { contains: ["x"] } }] } }
    )).toThrow(/path/u);
  });
});
