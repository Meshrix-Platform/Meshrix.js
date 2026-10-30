import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { validateUpstreamContentPolicy } from "../../../packages/contracts/src/upstream-service-publishing.ts";
const canned1 = "run";




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

function registryFor() : any {
  return createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim", consumed: true })
  });
}

function serviceWith(url: string, contentPolicy: any) : any {
  return structuredUpstreamServiceFixture({
    serviceId: "guarded",
    serviceProtocol: "http",
    label: "guarded",
    allowLocalNetwork: true,
    baseUrl: url,
    operations: [{
      operationKey: canned1,
      method: "POST",
      path: "/run",
      risk: "read_only",
      requiredScopes: ["gateway:write"],
      contentPolicy
    }]
  });
}

describe("Parameter-level policy expressions", () => {
  it("denies on a numeric threshold and a conjunctive range compare", async () => {
    const peer = await jsonPeer((body) => ({ echoed: body }));
    const registry = registryFor();
    installUpstreamRuntimeServices(registry, [serviceWith(peer.url, {
      request: { rules: [
        { id: "cap-amount", path: "body.amount", deny: { compare: { gt: 10_000 } } },
        { id: "bounded-count", path: "body.count", allow: { compare: { gte: 1, lte: 50 } } }
      ] }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { amount: 20_000, count: 10 } }, SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { amount: 500, count: 999 } }, SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      const ok = await registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { amount: 500, count: 10 } }, SUBJECT);
      expect(peer.hits.count).toBe(1);
      expect(ok.response.json.echoed.count).toBe(10);
      // A non-numeric selection never satisfies compare — allow side denies.
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: canned1, body: { amount: 5, count: "ten" } }, SUBJECT
      )).rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      expect(peer.hits.count).toBe(1);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("supports eq/neq/notIn/startsWith/endsWith and exists presence checks", async () => {
    const peer = await jsonPeer(() => ({ ok: true }));
    const registry = registryFor();
    installUpstreamRuntimeServices(registry, [serviceWith(peer.url, {
      request: { rules: [
        { id: "deny-debug-env", path: "body.env", deny: { eq: "debug" } },
        { id: "deny-foreign-region", path: "body.region", deny: { notIn: ["us", "eu"] } },
        { id: "deny-temp-prefix", path: "body.name", deny: { startsWith: "tmp_" } },
        { id: "deny-draft-suffix", path: "body.name", deny: { endsWith: "_draft" } },
        { id: "deny-missing-tenant", path: "body.tenant", deny: { exists: false } },
        { id: "deny-override-present", path: "body.override", deny: { exists: true } }
      ] }
    })]);
    try {
      const denied = [
        { env: "debug", tenant: "t" },
        { env: "prod", region: "cn", tenant: "t" },
        { env: "prod", region: "us", name: "tmp_scratch", tenant: "t" },
        { env: "prod", region: "us", name: "release_draft", tenant: "t" },
        { env: "prod", region: "us", name: "app" },
        { env: "prod", region: "us", name: "app", tenant: "t", override: true }
      ];
      for (const body of denied) {
        await expect(registry.forward({ serviceId: "guarded", operationKey: canned1, body }, SUBJECT))
          .rejects.toMatchObject({ status: 403, reasonCode: "upstream_content_policy_denied" });
      }
      expect(peer.hits.count).toBe(0);
      const ok = await registry.forward(
        { serviceId: "guarded", operationKey: canned1,
          body: { env: "prod", region: "eu", name: "release", tenant: "t" } }, SUBJECT);
      expect(ok.ok).toBe(true);
      expect(peer.hits.count).toBe(1);
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("rejects malformed expression matchers at the publishing boundary", () => {
    const expectBad = (matcher: Record<string, any>, pattern: RegExp) =>
      expect(() => validateUpstreamContentPolicy({
        request: { rules: [{ id: "r", path: "body.x", deny: matcher }] }
      })).toThrow(pattern);
    expectBad({ compare: { gt: "5" } }, /finite number/u);
    expectBad({ compare: {} }, /no comparison bound/u);
    expectBad({ compare: { gt: 1, between: 5 } }, /Unknown/u);
    expectBad({ eq: { nested: true } }, /eq/u);
    expectBad({ exists: "yes" }, /boolean/u);
    expectBad({ startsWith: "x".repeat(300) }, /startsWith/u);
    expectBad({ notIn: [] }, /array/u);
    expect(() => validateUpstreamContentPolicy({
      request: { rules: [{ id: "ok", path: "body.x",
        deny: { eq: "a", neq: "b", notIn: ["c"], startsWith: "t_", endsWith: "_z",
                exists: true, compare: { gt: 0, lte: 10 } } }] }
    })).not.toThrow();
    // Executable keys remain rejected — expressions are declarative only.
    expect(() => validateUpstreamContentPolicy({
      request: { rules: [{ id: "exec", path: "body.x", deny: { expression: "x > 0" } }] }
    })).toThrow(/Unknown/u);
  });
});
