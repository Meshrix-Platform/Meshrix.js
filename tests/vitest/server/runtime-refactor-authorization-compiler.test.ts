import { describe, expect, it, vi } from "vitest";
import { createAuthorizationEngine, evaluateAuthorizationPolicy } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";

function baseGrant() : any {
  return {
    id: "grant-compiler-test",
    type: "tool-grant",
    scopes: ["meshrix:workspace:read"],
    capabilities: ["cap:api:kernel.workspace.read", "cap:tool:kernel.workspace.read"],
    toolsets: ["core"],
    maxRisk: "safe_write",
    revision: 7
  };
}

function baseTool() : any {
  return {
    id: "kernel.workspace.read",
    operationId: "kernel.workspace.read",
    toolsets: ["core"],
    requiredScopes: ["meshrix:workspace:read"],
    readOnly: true,
    status: "active",
    revision: 4
  };
}

function baseSubject() : any {
  return {
    type: "console-user",
    subjectId: "user-compiler-test",
    roleId: "member",
    scopes: ["meshrix:workspace:read"],
    capabilities: ["cap:api:kernel.workspace.read", "cap:tool:kernel.workspace.read"],
    revision: 3
  };
}

describe("runtime refactor authorization compiler", () : any => {
  it("compiles structural facts once per exact revision key and reports cache hits", async () : Promise<any> => {
    const store: any = { appendDecision: vi.fn() };
    const engine: any = createAuthorizationEngine({ store });
    const grant: any = baseGrant();
    const tool: any = baseTool();
    const subject: any = baseSubject();
    const input: any = { grant, tool, subject, operation: { id: "kernel.workspace.read" } };

    const first: any = await engine.evaluate(input);
    expect(first).toMatchObject({ allowed: true, reasonCode: "allowed" });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      schemaVersion: "v0.0.1:risk-control:authorization-compiler-instrumentation-1",
      compiledSnapshotCount: 1,
      cacheHits: 0
    });

    const second: any = await engine.evaluate(input);
    expect(second).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 1,
      cacheHits: 1
    });

    const changed: any = await engine.evaluate({
      ...input,
      grant: { ...grant, revision: 8, toolsets: ["other"] }
    });
    expect(changed).toMatchObject({ allowed: false, reasonCode: "missing_toolsets" });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 2,
      cacheHits: 1
    });
  });

  it("keeps dynamic facts outside the cache: expiry, use count, origin, and source address", async () : Promise<any> => {
    const store: any = { appendDecision: vi.fn() };
    const engine: any = createAuthorizationEngine({ store });
    const grant: any = {
      ...baseGrant(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: 2,
      useCount: 0,
      allowedOrigins: ["https://app.example.com/"],
      allowedCidrs: ["10.0.0.0/8"]
    };
    const request: any = {
      socket: { remoteAddress: "10.1.2.3" },
      headers: { origin: "https://app.example.com" }
    };
    const input: any = { grant, tool: baseTool(), subject: baseSubject(), operation: { id: "kernel.workspace.read" }, request };

    const allowed: any = await engine.evaluate(input);
    expect(allowed).toMatchObject({ allowed: true, reasonCode: "allowed" });
    expect(engine.getRefactorInstrumentation()).toMatchObject({ compiledSnapshotCount: 1, cacheHits: 0 });

    const deniedOrigin: any = await engine.evaluate({
      ...input,
      request: { socket: { remoteAddress: "10.1.2.3" }, headers: { origin: "https://evil.example.com" } }
    });
    expect(deniedOrigin).toMatchObject({ allowed: false, reasonCode: "origin_not_allowed" });

    const deniedCidr: any = await engine.evaluate({
      ...input,
      request: { socket: { remoteAddress: "192.168.1.1" }, headers: { origin: "https://app.example.com" } }
    });
    expect(deniedCidr).toMatchObject({ allowed: false, reasonCode: "cidr_not_allowed" });

    const deniedUses: any = await engine.evaluate({
      ...input,
      grant: { ...grant, useCount: 2 }
    });
    expect(deniedUses).toMatchObject({ allowed: false, reasonCode: "grant_max_uses" });

    const deniedExpiry: any = await engine.evaluate({
      ...input,
      grant: { ...grant, expiresAt: new Date(Date.now() - 60_000).toISOString() }
    });
    expect(deniedExpiry).toMatchObject({ allowed: false, reasonCode: "grant_expired" });

    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 1,
      cacheHits: 4
    });
  });

  it("denies malformed structural facts with a typed decision and never caches them", async () : Promise<any> => {
    const store: any = { appendDecision: vi.fn() };
    const engine: any = createAuthorizationEngine({ store });
    const tool: any = baseTool();
    const subject: any = baseSubject();

    const malformedCidr: any = await engine.evaluate({
      grant: { ...baseGrant(), allowedCidrs: ["not-an-ip/999"] },
      tool,
      subject,
      operation: { id: "kernel.workspace.read" }
    });
    expect(malformedCidr).toMatchObject({ allowed: false, reasonCode: "malformed_credential_cidr", deniedLayer: "authorization_compiler" });
    expect(store.appendDecision).toHaveBeenCalled();

    const malformedOrigin: any = await engine.evaluate({
      grant: { ...baseGrant(), allowedOrigins: ["ftp://not-http"] },
      tool,
      subject,
      operation: { id: "kernel.workspace.read" }
    });
    expect(malformedOrigin).toMatchObject({ allowed: false, reasonCode: "malformed_credential_origin" });

    const malformedUses: any = await engine.evaluate({
      grant: { ...baseGrant(), maxUses: "many" },
      tool,
      subject,
      operation: { id: "kernel.workspace.read" }
    });
    expect(malformedUses).toMatchObject({ allowed: false, reasonCode: "malformed_credential_max_uses" });

    expect(engine.getRefactorInstrumentation()).toMatchObject({
      malformedFactDenials: 3,
      compiledSnapshotCount: 0,
      cacheHits: 0
    });

    const validAfter: any = await engine.evaluate({
      grant: baseGrant(),
      tool,
      subject,
      operation: { id: "kernel.workspace.read" }
    });
    expect(validAfter).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({ compiledSnapshotCount: 1 });
  });

  it("evicts the oldest compiled structure at the configured bound", async () : Promise<any> => {
    const engine: any = createAuthorizationEngine({ compiledFactsCacheLimit: 2 });
    const tool: any = baseTool();
    const subject: any = baseSubject();
    const evaluate: any = (revision: any) : any => engine.evaluate({
      grant: { ...baseGrant(), id: `grant-${revision}`, revision },
      tool,
      subject,
      operation: { id: "kernel.workspace.read" }
    });

    expect(await evaluate(1)).toMatchObject({ allowed: true });
    expect(await evaluate(2)).toMatchObject({ allowed: true });
    expect(await evaluate(3)).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 3,
      cacheEvictions: 1
    });
    expect(await evaluate(1)).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({ cacheHits: 0, compiledSnapshotCount: 4 });
  });

  it("never caches structural facts without an exact revision", async () : Promise<any> => {
    const engine: any = createAuthorizationEngine();
    const unrevisionedTool: any = { ...baseTool() };
    delete unrevisionedTool.revision;
    const input: any = {
      grant: baseGrant(),
      tool: unrevisionedTool,
      subject: baseSubject(),
      operation: { id: "kernel.workspace.read" }
    };

    expect(await engine.evaluate(input)).toMatchObject({ allowed: true });
    expect(await engine.evaluate(input)).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 2,
      cacheHits: 0,
      uncachedCompileCount: 2
    });
  });

  it("bypasses compiled structures that exceed the retained weight budget", async () : Promise<any> => {
    const engine: any = createAuthorizationEngine({
      compiledFactsCacheLimit: 8,
      compiledFactsCacheWeightLimit: 1024
    });
    const input: any = {
      grant: {
        ...baseGrant(),
        allowedSecretBindings: Array.from({ length: 96 }, (_, index) => `binding-${index.toString().padStart(3, "0")}-${"x".repeat(24)}`)
      },
      tool: baseTool(),
      subject: baseSubject(),
      operation: { id: "kernel.workspace.read" }
    };

    expect(await engine.evaluate(input)).toMatchObject({ allowed: true });
    expect(await engine.evaluate(input)).toMatchObject({ allowed: true });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 2,
      cacheHits: 0,
      cacheOversizeBypasses: 2,
      uncachedCompileCount: 2,
      cacheEntries: 0,
      cacheWeight: 0,
      cacheWeightLimit: 1024
    });
  });

  it("recompiles secret-binding authority at a new exact revision", async () : Promise<any> => {
    const engine: any = createAuthorizationEngine();
    const input: any = {
      grant: { ...baseGrant(), allowedSecretBindings: ["binding-a"] },
      tool: baseTool(),
      subject: baseSubject(),
      operation: { id: "kernel.workspace.read" },
      context: { resource: { secretBindingId: "binding-a" } }
    };

    expect(await engine.evaluate(input)).toMatchObject({ allowed: true });
    expect(await engine.evaluate({
      ...input,
      grant: { ...input.grant, revision: 8, allowedSecretBindings: ["binding-b"] }
    })).toMatchObject({ allowed: false, reasonCode: "secret_binding_not_allowed" });
    expect(engine.getRefactorInstrumentation()).toMatchObject({
      compiledSnapshotCount: 2,
      cacheHits: 0
    });
  });

  it("keeps the standalone evaluator decision matrix identical with and without compiled facts", async () : Promise<any> => {
    const tool: any = baseTool();
    const subject: any = baseSubject();
    const grant: any = {
      ...baseGrant(),
      allowedCidrs: ["10.0.0.0/8"],
      toolDeny: ["kernel.workspace.denied"]
    };
    const request: any = { socket: { remoteAddress: "10.1.1.1" }, headers: {} };
    const base: any = { grant, tool, subject, request };
    const engine: any = createAuthorizationEngine();

    const cases: any[] = [
      { ...base, operation: { id: "kernel.workspace.read" } },
      { ...base, operation: { id: "kernel.workspace.read" }, request: { socket: { remoteAddress: "198.51.100.8" }, headers: {} } },
      { ...base, operation: { id: "kernel.workspace.read" }, grant: { ...grant, toolDeny: [] } },
      { ...base, operation: { id: "kernel.workspace.read" }, subject: { ...subject, scopes: [] } },
      { ...base, operation: { id: "kernel.workspace.write" }, tool: { ...tool, id: "kernel.workspace.write", operationId: "kernel.workspace.write", readOnly: false, risk: "destructive" } }
    ];
    for (const input of cases) {
      const direct: any = evaluateAuthorizationPolicy(input);
      const compiled: any = await engine.evaluate(input);
      expect(compiled.allowed).toBe(direct.allowed);
      expect(compiled.reasonCode).toBe(direct.reasonCode);
    }
  });
});
