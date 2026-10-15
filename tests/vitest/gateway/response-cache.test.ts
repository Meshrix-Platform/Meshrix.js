import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { validateUpstreamResponseCache } from "../../../packages/contracts/src/upstream-service-publishing.ts";

const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: {
    id: "grant",
    subjectId: "operator",
    dynamicCapabilities: ["cap:upstream:cached:lookup"]
  },
  scopes: ["gateway:read"],
  dynamicCapabilities: ["cap:upstream:cached:lookup"]
};

async function jsonPeer(handler: (body: any) => any) : Promise<any> {
  const hits = { count: 0 };
  const peer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    hits.count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), hits.count)));
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

function cachedService(url: string, overrides: Record<string, any> = {}) : any {
  return structuredUpstreamServiceFixture({
    serviceId: "cached",
    serviceProtocol: "http",
    label: "cached",
    allowLocalNetwork: true,
    baseUrl: url,
    operations: [{
      operationKey: "lookup",
      method: "POST",
      path: "/lookup",
      risk: "read_only",
      requiredScopes: ["gateway:read"],
      responseCache: { ttlMs: 60_000 },
      ...overrides
    }]
  });
}

describe("Upstream response cache", () => {
  it("serves an identical read_only call from cache — no upstream hit, no permit claim", async () => {
    const peer = await jsonPeer((body, n) => ({ echoed: body, seq: n }));
    let claims = 0;
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => {
        claims += 1;
        return Object.freeze({ id: `claim-${claims}`, consumed: true });
      }
    });
    installUpstreamRuntimeServices(registry, [cachedService(peer.url)]);
    try {
      const first = await registry.forward(
        { serviceId: "cached", operationKey: "lookup", body: { q: "alpha" } }, SUBJECT);
      const second = await registry.forward(
        { serviceId: "cached", operationKey: "lookup", body: { q: "alpha" } }, SUBJECT);
      expect(peer.hits.count).toBe(1);
      expect(claims).toBe(1);
      expect(first.response.json.echoed.q).toBe("alpha");
      expect(second.response.json.echoed.q).toBe("alpha");
      expect(second.cache).toMatchObject({ hit: true });
      expect(typeof second.cache.storedAt).toBe("number");
      // The cached replay carries its own audit identity, not the origin call's.
      expect(second.auditId).not.toBe(first.auditId);
      // A distinct input is a distinct entry.
      await registry.forward(
        { serviceId: "cached", operationKey: "lookup", body: { q: "beta" } }, SUBJECT);
      expect(peer.hits.count).toBe(2);
      expect(claims).toBe(2);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("expires entries by ttlMs and republishes to a fresh service revision", async () => {
    const peer = await jsonPeer((body, n) => ({ echoed: body, seq: n }));
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim", consumed: true })
    });
    installUpstreamRuntimeServices(registry, [cachedService(peer.url, { responseCache: { ttlMs: 40 } })]);
    try {
      await registry.forward({ serviceId: "cached", operationKey: "lookup", body: { q: "x" } }, SUBJECT);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await registry.forward({ serviceId: "cached", operationKey: "lookup", body: { q: "x" } }, SUBJECT);
      expect(peer.hits.count).toBe(2);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("never caches write-risk operations even when responseCache is declared", async () => {
    const peer = await jsonPeer((body, n) => ({ echoed: body, seq: n }));
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim", consumed: true })
    });
    installUpstreamRuntimeServices(registry, [structuredUpstreamServiceFixture({
      serviceId: "cached",
      serviceProtocol: "http",
      label: "cached",
      allowLocalNetwork: true,
      baseUrl: peer.url,
      operations: [{
        operationKey: "lookup",
        method: "POST",
        path: "/lookup",
        risk: "safe_write",
        requiredScopes: ["gateway:read"],
        responseCache: { ttlMs: 60_000 }
      }]
    })]);
    const writerSubject = {
      ...SUBJECT,
      scopes: ["gateway:read", "gateway:write"],
      grant: { ...SUBJECT.grant, dynamicCapabilities: ["cap:upstream:cached:lookup"] },
      dynamicCapabilities: ["cap:upstream:cached:lookup"]
    };
    try {
      await registry.forward({ serviceId: "cached", operationKey: "lookup", body: { q: "x" } }, writerSubject);
      const again = await registry.forward({ serviceId: "cached", operationKey: "lookup", body: { q: "x" } }, writerSubject);
      expect(peer.hits.count).toBe(2);
      expect(again.cache?.hit).not.toBe(true);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("rejects malformed cache declarations at the contract boundary", () => {
    expect(() => validateUpstreamResponseCache({ ttlMs: 0 })).toThrow(/ttlMs/u);
    expect(() => validateUpstreamResponseCache({ ttlMs: 700_000 })).toThrow(/ttlMs/u);
    expect(() => validateUpstreamResponseCache({ ttlMs: 1000, maxEntries: 9999 })).toThrow(/maxEntries/u);
    expect(() => validateUpstreamResponseCache({ ttlMs: 1000, maxBytes: 999_999 })).toThrow(/maxBytes/u);
    expect(() => validateUpstreamResponseCache({ ttlMs: 1000, extra: true })).toThrow(/Unknown/u);
    expect(() => validateUpstreamResponseCache("never")).toThrow(/object/u);
    expect(() => validateUpstreamResponseCache({ ttlMs: 60_000 })).not.toThrow();
  });
});
