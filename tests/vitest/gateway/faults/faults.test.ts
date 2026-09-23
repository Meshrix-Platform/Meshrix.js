import { describe, expect, it } from "vitest";
import { context, descriptor, response, route, key, createTestGateway as createGateway } from "../support";

describe("gateway fault and uncertain-outcome boundaries", () => {
  it("[CASE-L04] marks a stateful context lost on a fatal upstream 404", async () => {
    const gateway = createGateway({ upstream: { invoke: async () => response({ error: { code: "session_missing" } }, 404) }, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const created = gateway.createContext({ tenant: context.tenant, principal: context.principal, grantRevision: "grant-1", credentialGeneration: context.authGeneration, routeRef: "route.demo" });
      const outcome = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {}, contextHandle: created.handle });
      expect(outcome).toMatchObject({ kind: "failure", code: "upstream_context_lost" });
      expect(() => gateway.contextStore.get(created.handle)).toThrowError(/no longer recoverable/u);
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-F03] [CASE-F04] records unknown external outcomes and never retries the effect", async () => {
    let calls = 0;
    let unknown = 0;
    const gateway = createGateway({
      upstream: { invoke: async () => { calls += 1; throw Object.assign(new Error("connection lost after write"), { sent: true }); } },
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      permits: {
        issue: ({ prepared }) => ({ id: `permit-${calls + 1}`, audience: prepared.route.endpointIdentity, target: prepared.route.endpointIdentity, tenant: context.tenant, principal: context.principal, inputDigest: prepared.inputDigest, routeRevision: prepared.route.revision, grantRevision: "grant-1", policyRevision: "policy", expiresAt: Date.now() + 10000, state: "issued" }),
        consume: ({ permit }) => ({ ...permit, state: "consumed" }),
        markOutcomeUnknown: (permit) => { unknown += 1; return { ...permit, state: "outcome_unknown" }; }
      }
    });
    await gateway.start();
    try {
      const outcome = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(outcome).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(calls).toBe(1);
      expect(unknown).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-L03] marks a stateful context lost on a non-404 fatal HTTP response", async () => {
    const gateway = createGateway({ upstream: { invoke: async () => response("upstream stopped", 503) }, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const created = gateway.createContext({ tenant: context.tenant, principal: context.principal, grantRevision: "grant-1", credentialGeneration: context.authGeneration, routeRef: "route.demo" });
      const outcome = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {}, contextHandle: created.handle });
      expect(outcome).toMatchObject({ kind: "failure", code: "upstream_http_503", effectOutcome: "unknown" });
      expect(() => gateway.contextStore.get(created.handle)).toThrowError(/no longer recoverable/u);
    } finally {
      await gateway.close();
    }
  });

  it("marks a stateful context lost when the upstream process exits", async () => {
    const gateway = createGateway({ upstream: { invoke: async () => { throw Object.assign(new Error("process exited"), { code: "upstream_process_exit" }); } }, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const created = gateway.createContext({ tenant: context.tenant, principal: context.principal, grantRevision: "grant-1", credentialGeneration: context.authGeneration, routeRef: "route.demo" });
      await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {}, contextHandle: created.handle });
      expect(() => gateway.contextStore.get(created.handle)).toThrowError(/no longer recoverable/u);
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-F05] rejects a context handle after grant or credential rotation", async () => {
    let calls = 0;
    const gateway = createGateway({ upstream: { invoke: async () => { calls += 1; return response({ resultType: "complete", value: "ok" }); } }, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const created = gateway.createContext({ tenant: context.tenant, principal: context.principal, grantRevision: "grant-1", credentialGeneration: "credential-1", routeRef: "route.demo" });
      const rotated = { ...context, grant: { revision: "grant-2" }, metadata: { credentialGeneration: "credential-2" } } as typeof context;
      expect(await gateway.invoke(rotated, { routeRef: "route.demo", method: "tools/call", params: {}, contextHandle: created.handle })).toMatchObject({ kind: "failure", code: "context_binding_mismatch" });
      expect(calls).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it("transitions a consumed permit when an upstream HTTP error has no JSON-RPC body", async () => {
    let markedUnknown = 0;
    const gateway = createGateway({
      upstream: { invoke: async () => response("bad gateway", 502) },
      descriptors: [descriptor()],
      permits: {
        issue: ({ prepared }) => ({ id: "permit-http", audience: prepared.route.endpointIdentity, target: prepared.route.endpointIdentity, tenant: context.tenant, principal: context.principal, inputDigest: prepared.inputDigest, routeRevision: prepared.route.revision, grantRevision: "grant-1", policyRevision: "policy", expiresAt: Date.now() + 10000, state: "issued" }),
        consume: ({ permit }) => ({ ...permit, state: "consumed" }),
        markOutcomeUnknown: (permit) => { markedUnknown += 1; return { ...permit, state: "outcome_unknown" }; }
      }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(markedUnknown).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("requires a continuation codec for upstream input requests instead of making an implicit replay path", async () => {
    const gateway = createGateway({ upstream: { invoke: async () => response({ resultType: "input_required", inputRequests: [] }) }, descriptors: [descriptor()] });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", code: "continuation_unavailable" });
    } finally {
      await gateway.close();
    }
  });
});
