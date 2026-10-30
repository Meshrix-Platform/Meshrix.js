import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
const canned1 = "run";




const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: { id: "grant", subjectId: "operator", dynamicCapabilities: ["cap:upstream:guarded:run"] },
  scopes: ["gateway:write"],
  dynamicCapabilities: ["cap:upstream:guarded:run"]
};

function httpService(overrides: Record<string, any> = {}) : any {
  return structuredUpstreamServiceFixture({
    serviceId: "guarded",
    serviceProtocol: "http",
    label: "guarded",
    allowLocalNetwork: true,
    baseUrl: "http://127.0.0.1:1",
    operations: [{ operationKey: canned1, method: "POST", path: "/run", requiredScopes: ["gateway:write"], risk: "safe_write" }],
    ...overrides
  });
}

async function jsonPeer(handler: () => any = () => ({ ok: true })) : Promise<any> {
  const hits = { count: 0 };
  const peer = createServer(async (_request, response) => {
    hits.count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler()));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("peer unavailable");
  return { url: `http://127.0.0.1:${address.port}`, hits, close: () => new Promise<void>((resolve) => peer.close(() => resolve())) };
}

function registryWithGate(policyGate: any, extra: Record<string, any> = {}) : any {
  const counters = { claims: 0, gateCalls: 0 };
  const gate = typeof policyGate === "function"
    ? async (context: any, options: any) => { counters.gateCalls += 1; return policyGate(context, options); }
    : policyGate;
  const registry = createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    policyGate: gate,
    claimProtectedSinkAttempt: async () => {
      counters.claims += 1;
      return Object.freeze({ id: `claim-${counters.claims}`, consumed: true });
    },
    ...extra
  });
  return { registry, counters };
}

describe("Upstream external policy gate", () => {
  it("denies before touching upstream or consuming a permit", async () => {
    const peer = await jsonPeer();
    const { registry, counters } = registryWithGate(async () => ({ allowed: false, reason: "tenant_blocked" }));
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { hello: "world" } },
        SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_policy_gate_denied" });
      expect(peer.hits.count).toBe(0);
      expect(counters.claims).toBe(0);
      expect(counters.gateCalls).toBe(1);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("receives bounded context and lets an allowed decision through", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const seen: any[] = [];
    const { registry } = registryWithGate(async (context: any) => {
      seen.push(context);
      return { allowed: true };
    });
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url })]);
    try {
      await registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { hello: "world" } },
        SUBJECT
      );
      expect(peer.hits.count).toBe(1);
      expect(seen[0]).toMatchObject({
        serviceId: "guarded",
        operationKey: canned1,
        method: "POST",
        subject: { type: "tool-grant", subjectId: "operator", grantId: "grant" }
      });
      expect(seen[0].input.body).toEqual({ hello: "world" });
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("fails closed when the gate throws, times out, or answers malformed", async () => {
    const peer = await jsonPeer();
    for (const gate of [
      async () => { throw new Error("policy backend unreachable"); },
      async () => new Promise(() => {}),
      async () => ({ verdict: "nope" })
    ]) {
      const { registry, counters } = registryWithGate(gate, { policyGateTimeoutMs: 50 });
      installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url })]);
      try {
        await expect(registry.forward(
          { serviceId: "guarded", operationKey: canned1, body: {} },
          SUBJECT
        )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_policy_gate_unavailable" });
        expect(counters.claims).toBe(0);
      } finally {
        await registry.close();
      }
    }
    expect(peer.hits.count).toBe(0);
    await peer.close();
  });

  it("stays inert when no gate is configured", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim-1", consumed: true })
    });
    installUpstreamRuntimeServices(registry, [httpService({ baseUrl: peer.url })]);
    try {
      await registry.forward({ serviceId: "guarded", operationKey: canned1, body: {} }, SUBJECT);
      expect(peer.hits.count).toBe(1);
    } finally {
      await registry.close();
      await peer.close();
    }
  });
});
