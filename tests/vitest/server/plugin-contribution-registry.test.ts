import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createPluginContributionRegistry
} from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.ts";
import { createPluginContributionController } from "../../../packages/server-runtime/src/composition/plugin-contribution-controller.ts";
import { createPluginWorkspaceAccess } from "../../../packages/server-runtime/src/composition/plugin-workspace-access.ts";
import { createCapturedResponse, parseCapturedResult } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.ts";
import {
  SANDBOX_CUSTODY_PROMOTION_SCHEMA,
  custodyPromotionAuthorizationDigest,
  custodyPromotionSetDigest
} from "../../../packages/foundation/src/execution-sandbox/custody-contracts.ts";

const CONTRIBUTION_KINDS: readonly any[] = Object.freeze([
  "operations",
  "routes",
  "mcpTools",
  "consoleEntries",
  "stateMachines",
  "verifierHooks"
]);
const TEST_ARTIFACT_IDENTITY: Readonly<Record<string, any>> = Object.freeze({
  pluginId: "demo",
  version: "0.0.1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  generation: 1,
  keyId: "ed25519:test",
  coreContractDigest: `sha256:${"b".repeat(64)}`
});
const TEST_ARTIFACT_OPTIONS: Readonly<Record<string, any>> = Object.freeze({
  artifactIdentityResolver: () : any => TEST_ARTIFACT_IDENTITY,
  artifactFileReader: async (_manifest?: any, filePath?: any) : Promise<any> => Buffer.from(`export const asset = ${JSON.stringify(filePath)};`)
});

function definition(id: any = "demo.run", patch: Record<string, any> = {}) : any {
  const resource: Record<string, any> = {
    capabilityDomain: "demo",
    resourceKind: "demo_task",
    capabilityVerb: "run",
    effectKind: "write",
    fieldMap: {}
  };
  return {
    id,
    feature: "system",
    featureId: "core-platform",
    toolsets: ["meshrix.gateway.write"],
    label: id,
    target: { controller: "ignored", method: "ignored" },
    http: { method: "POST", path: `/api/${id.replaceAll(".", "/")}` },
    rpc: { method: id, body: "params" },
    cli: { command: id.split("."), usage: id.replaceAll(".", " ") },
    requiredScopes: ["demo:run"],
    inputSchema: { type: "object", additionalProperties: true },
    safety: { risk: "safe_write", requiresConfirmation: false },
    resource,
    resourceContext: { ...resource },
    ...patch
  };
}

function manifest(patch: Record<string, any> = {}) : any {
  return {
    id: "demo",
    version: "0.0.1",
    features: ["core-platform"],
    operations: ["demo.run"],
    routes: [{ id: "demo.run.http", path: "/api/demo/run", kind: "http" }],
    mcpTools: ["meshrix.demo.run"],
    consoleEntries: ["admin.demo"],
    stateMachines: [],
    verifierHooks: [{
      id: "demo.verify",
      workloadKind: "plugin_verifier.demo",
      source: "verifiers/demo.ts",
      report: ""
    }],
    ...patch
  };
}

function opaqueInputContract({ maxBytes = 1024 * 1024 }: Record<string, any> = {}) : any {
  return Object.freeze([Object.freeze({
    schemaVersion: "v0.0.1:plugin:opaque-input-preprocessing-1",
    encoding: "base64",
    sourceField: "contentBase64",
    targetField: "opaqueInput",
    mediaType: "application/octet-stream",
    maxBytes,
    outputSchemaVersion: "v0.0.1:plugin:opaque-input-handle-1"
  })]);
}

function hostPathInputContract({ targetField = "mountSelectionRef" }: Record<string, any> = {}) : any {
  return Object.freeze([Object.freeze({
    schemaVersion: "v0.0.1:plugin:host-path-input-preprocessing-1",
    kind: "local-directory-selection",
    sourceField: "sourcePath",
    targetField
  })]);
}

function opaqueRegistry({ execute, contract = opaqueInputContract() }: Record<string, any> = {}) : any {
  const plugin: any = manifest({ opaqueInputPreprocessing: { "demo.run": contract } });
  return createPluginContributionRegistry({
    manifests: [plugin],
    loadedPlugins: [plugin],
    contributions: enabledContributions({
      execute,
      opaqueInputPreprocessing: contract,
      requiredHostPorts: ["opaqueArtifactCustody"]
    }),
    coreOperations: [],
    activeFeatureIds: ["core-platform"],
    ...TEST_ARTIFACT_OPTIONS
  });
}

function record(pluginId?: any, kind?: any, id?: any, implementation?: any) : any {
  return Object.freeze({ pluginId, kind, id, implementation: Object.freeze(implementation) });
}

function outletDescriptor(toolName: any = "meshrix.demo") : any {
  return Object.freeze({
    toolName,
    title: "Meshrix.js Demo",
    description: "Demo plugin outlet.",
    architectureCategory: "Demo",
    annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false })
  });
}

function enabledContributions(operationPatch: Record<string, any> = {}) : any {
  const execute: any = operationPatch.execute || vi.fn(async ({ host }: Record<string, any>) : Promise<any> => ({
    ok: true,
    exposedSecurityMethods: Object.keys(host.securityPermissions || {})
  }));
  return {
    operations: {
      "demo.run": record("demo", "operations", "demo.run", {
        definition: definition(),
        execute,
        requiredHostPorts: ["securityPermissions"],
        ...operationPatch
      })
    },
    routes: {
      "demo.run.http": record("demo", "routes", "demo.run.http", { operationId: "demo.run" })
    },
    mcpTools: {
      "meshrix.demo.run": record("demo", "mcpTools", "meshrix.demo.run", {
        operationId: "demo.run",
        outlet: "meshrix.gateway"
      })
    },
    consoleEntries: {
      "admin.demo": record("demo", "consoleEntries", "admin.demo", {
        featureId: "core-platform",
        viewKey: "demo",
        routePath: "/admin/demo",
        componentId: "demo/DemoView",
        assetPath: "console/index.ts",
        assetExport: "mountPluginConsole",
        requiredScopes: ["demo:run"]
      })
    },
    stateMachines: {},
    verifierHooks: {
      "demo.verify": record("demo", "verifierHooks", "demo.verify", {})
    }
  };
}

function createRegistry(contributions: any = enabledContributions(), patch: Record<string, any> = {}) : any {
  const plugin: any = manifest();
  return createPluginContributionRegistry({
    manifests: [plugin],
    loadedPlugins: [plugin],
    contributions,
    coreOperations: [],
    activeFeatureIds: ["core-platform"],
    ...TEST_ARTIFACT_OPTIONS,
    ...patch
  });
}

describe("plugin contribution registry", () : any => {
  it("projects one enabled definition into the shared HTTP/RPC/tool surface", () : any => {
    const registry: any = createRegistry();
    expect(registry.activeOperations).toHaveLength(1);
    expect(registry.activeOperations[0]).toMatchObject({
      id: "demo.run",
      toolId: "meshrix.demo.run",
      requiredScopes: ["demo:run"],
      target: { controller: "plugin", method: "executePluginOperation" },
      _meta: { mcpOutlet: "meshrix.gateway" }
    });
    expect(registry.publicRuntime().routes).toHaveLength(1);
    expect(registry.publicRuntime().mcpTools).toHaveLength(1);
    expect(registry.publicRuntime().consoleEntries).toHaveLength(1);
    expect(registry.publicRuntime().verifierHooks).toHaveLength(1);
    expect(registry.currentActiveOperations()).toBe(registry.activeOperations);
    expect(registry.currentActiveOperations()).toBe(registry.currentActiveOperations());
  });

  it("binds declared console assets to the active immutable artifact identity", async () : Promise<any> => {
    const artifactFileReader: any = vi.fn(async (_manifest?: any, filePath?: any) : Promise<any> =>
      Buffer.from(`export const asset = ${JSON.stringify(filePath)};`));
    const registry: any = createRegistry(enabledContributions(), { artifactFileReader });
    const [entry] = registry.publicRuntime().consoleEntries;

    expect(entry).toMatchObject({
      pluginId: "demo",
      assetExport: "mountPluginConsole",
      artifactDigest: TEST_ARTIFACT_IDENTITY.artifactDigest,
      artifactGeneration: TEST_ARTIFACT_IDENTITY.generation
    });
    expect(entry.assetUrl).toMatch(/^\/api\/plugins\/v1\/console-assets\/demo\/1\/[a-f0-9]{64}\//u);
    expect(entry).not.toHaveProperty("assetPath");
    expect(registry.getConsoleAssetEntry(entry.assetUrl)).toEqual(entry);

    const asset: any = await registry.readConsoleAsset(entry.assetUrl);
    expect(asset.entry).toEqual(entry);
    expect(asset.bytes.toString("utf8")).toContain("console/index.ts");
    expect(artifactFileReader).toHaveBeenCalledWith(expect.objectContaining({ id: "demo" }), "console/index.ts");
    expect(await registry.readConsoleAsset(`${entry.assetUrl}.unknown`)).toBeNull();

    registry.deactivatePlugin("demo");
    expect(registry.getConsoleAssetEntry(entry.assetUrl)).toBeNull();
    expect(await registry.readConsoleAsset(entry.assetUrl)).toBeNull();
  });

  it("rejects unsafe or incomplete console artifact declarations", () : any => {
    for (const patch of [
      { assetPath: "../runtime.ts" },
      { assetPath: "runtime.ts" },
      { assetPath: "console\\index.ts" },
      { assetPath: "console//index.ts" },
      { assetExport: "default export" }
    ]) {
      const contributions: any = enabledContributions();
      const original: any = contributions.consoleEntries["admin.demo"];
      contributions.consoleEntries["admin.demo"] = record("demo", "consoleEntries", "admin.demo", {
        ...original.implementation,
        ...patch
      });
      expect(() : any => createRegistry(contributions)).toThrow(/console entry .* is invalid/u);
    }
  });

  it("admits each plugin contribution once into an immutable snapshot", () : any => {
    const source: any = enabledContributions();
    const reads: any = Object.fromEntries(CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, 0]));
    const contributions: Record<string, any> = {};
    for (const kind of CONTRIBUTION_KINDS) {
      Object.defineProperty(contributions, kind, {
        enumerable: true,
        get() : any {
          reads[kind] += 1;
          return source[kind];
        }
      });
    }

    const registry: any = createRegistry(contributions);
    source.operations["demo.run"].implementation.definition.resource.fieldMap.injected = true;
    source.consoleEntries["admin.demo"].implementation.requiredScopes.push("injected:scope");

    expect(reads).toEqual(Object.fromEntries(CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, 1])));
    expect(registry.activeOperations[0].resource.fieldMap).toEqual({});
    expect(registry.publicRuntime().consoleEntries[0].requiredScopes).toEqual(["demo:run"]);
    expect(Object.isFrozen(registry.activeOperations[0].resource.fieldMap)).toBe(true);
    expect(registry.operations.set).toBeUndefined();
    expect(registry.publicRuntime()).toEqual(registry.publicRuntime());
    expect(reads).toEqual(Object.fromEntries(CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, 1])));
  });

  it("removes every dynamic surface and rejects a captured operation after deactivation", async () : Promise<any> => {
    const registry: any = createRegistry();
    const capturedOperation: any = registry.activeOperations[0];
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: { securityPermissions: { appendLoanRecord() : any {} } }
    });

    expect(registry.deactivatePlugin("demo")).toMatchObject({ ok: true, changed: true });
    expect(registry.currentActiveOperations()).toEqual([]);
    expect(registry.enabledPlugins).toEqual([]);
    expect(registry.publicRuntime()).toMatchObject({
      enabledPlugins: [],
      routes: [],
      mcpTools: [],
      consoleEntries: [],
      verifierHooks: []
    });
    expect(registry.stateMachines.size).toBe(0);

    const response: any = createCapturedResponse();
    await controller.executePluginOperation({ operation: capturedOperation, input: {}, response });
    expect(response.statusCode).toBe(404);
    expect(parseCapturedResult({ operation: capturedOperation, captured: response })).toEqual({
      ok: false,
      error: { code: "plugin_operation_unavailable", retryable: false }
    });
  });

  it("atomically replaces one active plugin contribution set without deactivating its product", async () : Promise<any> => {
    const registry: any = createRegistry();
    const capturedOperation: any = registry.activeOperations[0];
    const controller: any = createPluginContributionController({ registry });
    const empty: any = Object.fromEntries(CONTRIBUTION_KINDS.map((kind?: any) : any => [kind, {}]));
    const change: any = registry.preparePluginContributionReplacement("demo", empty);

    change.commit();
    expect(registry.enabledPlugins).toHaveLength(1);
    const emptySnapshot: any = registry.currentActiveOperations();
    expect(emptySnapshot).toEqual([]);
    expect(registry.currentActiveOperations()).toBe(emptySnapshot);
    expect(registry.publicRuntime()).toMatchObject({
      routes: [], mcpTools: [], consoleEntries: [], stateMachines: [], verifierHooks: []
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({ operation: capturedOperation, input: {}, response });
    expect(response.statusCode).toBe(404);

    change.rollback();
    const restoredSnapshot: any = registry.currentActiveOperations();
    expect(restoredSnapshot).toHaveLength(1);
    expect(restoredSnapshot).not.toBe(emptySnapshot);
    expect(registry.currentActiveOperations()).toBe(restoredSnapshot);
    expect(registry.publicRuntime().routes).toHaveLength(1);
  });

  it("injects only declared facade methods and writes the canonical result envelope", async () : Promise<any> => {
    const registry: any = createRegistry();
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        securityPermissions: {
          appendLoanRecord() : any {},
          deleteAllGrants() : any {}
        }
      }
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: { value: 1 },
      response
    });
    expect(parseCapturedResult({ operation: registry.activeOperations[0], captured: response })).toEqual({
      ok: true,
      exposedSecurityMethods: ["appendLoanRecord"]
    });
  });

  it("passes plugins only an immutable serializable call projection and a separate cancellation capability", async () : Promise<any> => {
    const execute: any = vi.fn(async () : Promise<any> => ({ ok: true }));
    const registry: any = createRegistry(enabledContributions({ execute, requiredHostPorts: [] }));
    const controller: any = createPluginContributionController({ registry });
    const response: any = createCapturedResponse();
    const signal: any = new AbortController().signal;
    const credential: any = "fixture-mobile-credential-0123456789abcdef";
    const request: Record<string, any> = {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        cookie: "private=fixture",
        "content-type": "application/json"
      },
      socket: { remoteAddress: "192.0.2.10" },
      __meshrixTraceContext: { traceId: "trace-fixture", requestId: "request-fixture" },
      __meshrixToolRuntimeAuthorization: {
        ok: true,
        grant: {
          id: "grant-fixture",
          scopes: ["demo:run"],
          credential: "must-not-cross-boundary",
          metadata: { policyRevision: "policy-fixture" }
        },
        policy: { decisionId: "decision-fixture" }
      }
    };
    request.self = request;

    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: {},
      request,
      response,
      signal,
      authSession: {
        user: { userId: "subject-fixture", tenantId: "tenant-fixture", scopes: ["demo:run"] }
      },
      requestBody: Buffer.from("private-body")
    });

    const args: any = execute.mock.calls[0][0];
    expect(args.signal).toBe(signal);
    expect(Object.isFrozen(args.call)).toBe(true);
    expect(Object.isFrozen(args.call.headers)).toBe(true);
    expect(JSON.parse(JSON.stringify(args.call))).toEqual(args.call);
    expect(args.call).toMatchObject({
      schemaVersion: "v0.0.1:plugin:call-context-1",
      transport: "http",
      method: "POST",
      headers: {
        contentType: "application/json",
        authorizationScheme: "bearer",
        credentialDigests: {
          authorization: createHash("sha256").update(credential).digest("hex")
        }
      },
      cancellation: { aborted: false },
      governance: {
        authorized: true,
        grantRef: "grant-fixture",
        riskDecisionRef: "decision-fixture",
        policyRevision: "policy-fixture",
        scopes: ["demo:run"]
      },
      trace: {
        traceRef: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/u),
        requestRef: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(args.call).not.toHaveProperty("request");
    expect(args.call).not.toHaveProperty("response");
    expect(args.call).not.toHaveProperty("requestBody");
    expect(args.call.headers).not.toHaveProperty("authorization");
    expect(args.call.headers).not.toHaveProperty("cookie");
    expect(JSON.stringify(args.call)).not.toContain(credential);
    expect(JSON.stringify(args.call)).not.toContain("192.0.2.10");
    expect(JSON.stringify(args.call)).not.toContain("trace-fixture");
    expect(JSON.stringify(args.call)).not.toContain("request-fixture");
    expect(JSON.stringify(args.call)).not.toContain("must-not-cross-boundary");
    expect(args.call.sourceKey).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(args.call.auth.subjectRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(args.call.auth.tenantRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(args.call)).not.toContain(
      createHash("sha256").update("plugin-call-source:192.0.2.10").digest("hex")
    );
    expect(JSON.stringify(args.call)).not.toContain(
      createHash("sha256").update("plugin-call-subject:subject-fixture").digest("hex")
    );
  });

  it("does not emit reusable credential digests for low-entropy bearer values", async () : Promise<any> => {
    const execute: any = vi.fn(async () : Promise<any> => ({ ok: true }));
    const registry: any = createRegistry(enabledContributions({ execute, requiredHostPorts: [] }));
    await createPluginContributionController({ registry }).executePluginOperation({
      operation: registry.activeOperations[0],
      input: {},
      request: { headers: { authorization: "Bearer short-fixture" } },
      response: createCapturedResponse()
    });
    const projection: any = execute.mock.calls[0][0].call;
    expect(projection.headers).toMatchObject({ authorizationScheme: "bearer" });
    expect(projection.headers).not.toHaveProperty("credentialDigests");
    expect(JSON.stringify(projection)).not.toContain("short-fixture");
    expect(JSON.stringify(projection)).not.toContain(
      createHash("sha256").update("short-fixture").digest("hex")
    );
  });

  it("projects opaque workspace methods and enforces the core-owned path boundary", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-workspace-"));
    const outsideRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-workspace-outside-"));
    try {
      await fs.writeFile(path.join(root, "existing.txt"), "before", "utf8");
      const outsideFile: any = path.join(outsideRoot, "outside.txt");
      await fs.writeFile(outsideFile, "outside", "utf8");
      await fs.symlink(outsideFile, path.join(root, "linked.txt"));
      await fs.symlink(outsideRoot, path.join(root, "linked-directory"));
      const workspaceAccess: any = createPluginWorkspaceAccess({ workspaceRoot: root });
      const execute: any = vi.fn(async ({ host }: Record<string, any>) : Promise<any> => ({
        ok: true,
        methods: Object.keys(host.workspaceAccess).sort(),
        content: await host.workspaceAccess.readTextFile({ path: "existing.txt" })
      }));
      const registry: any = createRegistry(enabledContributions({
        execute,
        requiredHostPorts: ["workspaceAccess"]
      }));
      const controller: any = createPluginContributionController({
        registry,
        hostPorts: { workspaceAccess }
      });
      const response: any = createCapturedResponse();
      await controller.executePluginOperation({
        operation: registry.activeOperations[0],
        input: {},
        response
      });
      expect(parseCapturedResult({ operation: registry.activeOperations[0], captured: response })).toEqual({
        ok: true,
        methods: ["readTextFile", "writeTextFile"],
        content: "before"
      });
      await expect(workspaceAccess.readTextFile({ path: "../outside.txt" })).rejects.toMatchObject({
        code: "PLUGIN_WORKSPACE_READ_DENIED",
        message: "Plugin workspace access was denied."
      });
      await expect(workspaceAccess.readTextFile({ path: "linked.txt" })).rejects.toMatchObject({
        code: "PLUGIN_WORKSPACE_READ_DENIED"
      });
      await expect(workspaceAccess.writeTextFile({ path: "linked.txt", content: "changed" })).rejects.toMatchObject({
        code: "PLUGIN_WORKSPACE_WRITE_DENIED"
      });
      await expect(workspaceAccess.writeTextFile({
        path: "linked-directory/created.txt",
        content: "changed"
      })).rejects.toMatchObject({ code: "PLUGIN_WORKSPACE_WRITE_DENIED" });
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
      await expect(fs.stat(path.join(outsideRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await workspaceAccess.writeTextFile({ path: "nested/created.txt", content: "after" });
      await expect(fs.readFile(path.join(root, "nested/created.txt"), "utf8")).resolves.toBe("after");
      expect((await fs.readdir(path.join(root, "nested"))).some((name?: any) : any => name.startsWith(".meshrix-write-"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("projects only delegated MCP grant broker methods into plugin operations", async () : Promise<any> => {
    const execute: any = vi.fn(async ({ host }: Record<string, any>) : Promise<any> => ({
      ok: true,
      brokerMethods: Object.keys(host.delegatedMcpGrantBroker || {}).sort()
    }));
    const registry: any = createRegistry(enabledContributions({
      execute,
      requiredHostPorts: ["delegatedMcpGrantBroker"]
    }));
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        delegatedMcpGrantBroker: {
          createDelegatedMcpGrant() : any {},
          revokeDelegatedMcpGrant() : any {},
          listGrants() : any {},
          rawStore: {}
        }
      }
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: {},
      response
    });
    expect(parseCapturedResult({ operation: registry.activeOperations[0], captured: response })).toEqual({
      ok: true,
      brokerMethods: ["createDelegatedMcpGrant", "revokeDelegatedMcpGrant"]
    });
  });

  it("projects only appendAlert through the security alert host port", async () : Promise<any> => {
    const execute: any = vi.fn(async ({ host }: Record<string, any>) : Promise<any> => ({
      ok: true,
      alertMethods: Object.keys(host.securityAlertStore || {}).sort()
    }));
    const registry: any = createRegistry(enabledContributions({
      execute,
      requiredHostPorts: ["securityAlertStore"]
    }));
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        securityAlertStore: {
          appendAlert() : any {},
          listAlerts() : any {}
        }
      }
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: {},
      response
    });
    expect(parseCapturedResult({ operation: registry.activeOperations[0], captured: response })).toEqual({
      ok: true,
      alertMethods: ["appendAlert"]
    });
  });

  it("records plugin grant evidence only under the current Operation Permission authorization", async () : Promise<any> => {
    const loanRecord: Readonly<Record<string, any>> = Object.freeze({
      loanRecordId: "loan-record-1",
      contributionGrantId: "contribution-grant-1",
      contributionId: "contribution-1",
      granteeId: "subject-1",
      targetWorkspaceId: "workspace-1",
      actions: Object.freeze(["use"]),
      expiresAt: "2099-01-01T00:00:00.000Z",
      revocationPolicy: "revoke-on-policy-change",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceId: "workspace-1",
      canShare: false,
      canRetain: false
    });
    const appendLoanRecord: any = vi.fn(async () : Promise<any> => ({ loanRecordId: "host-loan-record-1" }));
    const execute: any = vi.fn(async ({ host, input }: Record<string, any>) : Promise<any> => ({
      ok: true,
      methods: Object.keys(host.operationPermissionGrant || {}).sort(),
      receipt: await host.operationPermissionGrant.recordPluginGrant({
        loanRecord: input.invalid === true ? { ...loanRecord, unsupported: true } : loanRecord
      })
    }));
    const registry: any = createRegistry(enabledContributions({
      execute,
      requiredHostPorts: ["operationPermissionGrant"]
    }));
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        operationPermissionGrant: {
          securityPermissions: { appendLoanRecord },
          rawGrantStore: { forbidden: true }
        }
      }
    });
    const operation: any = registry.activeOperations[0];

    await expect(controller.executePluginOperation({
      operation,
      input: {},
      response: createCapturedResponse()
    })).rejects.toMatchObject({ code: "plugin_permission_grant_current_authorization_required" });
    expect(appendLoanRecord).not.toHaveBeenCalled();

    const authorizedCall: any = (input?: any, response?: any) : any => controller.executePluginOperation({
      operation,
      input,
      request: {
        __meshrixToolRuntimeAuthorization: {
          ok: true,
          grant: { id: "grant-fixture", scopes: ["demo:run"], metadata: { policyRevision: "policy-fixture" } },
          policy: { decisionId: "decision-fixture" }
        }
      },
      authSession: { user: { userId: "subject-fixture", tenantId: "tenant-fixture" } },
      response
    });
    await expect(authorizedCall({ invalid: true }, createCapturedResponse()))
      .rejects.toMatchObject({ code: "plugin_permission_grant_record_invalid" });
    expect(appendLoanRecord).not.toHaveBeenCalled();

    appendLoanRecord.mockRejectedValueOnce(new Error("private backend detail"));
    await expect(authorizedCall({}, createCapturedResponse())).rejects.toMatchObject({
      code: "plugin_permission_grant_host_failed",
      message: "Plugin permission grant evidence was denied."
    });

    const response: any = createCapturedResponse();
    await authorizedCall({}, response);
    expect(parseCapturedResult({ operation, captured: response })).toEqual({
      ok: true,
      methods: ["recordPluginGrant"],
      receipt: {
        ok: true,
        receiptId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(appendLoanRecord).toHaveBeenCalledTimes(2);
    const [evidence, metadata] = appendLoanRecord.mock.calls[1];
    expect(evidence).toMatchObject({
      schemaVersion: "v0.0.1:plugin:permission-grant-evidence-1",
      pluginId: "demo",
      operationId: "demo.run",
      loanRecord,
      authorization: {
        grantDigest: createHash("sha256").update("grant-fixture").digest("hex"),
        authorizationContextDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        riskDecisionRef: "decision-fixture",
        policyRevision: "policy-fixture"
      }
    });
    expect(metadata).toMatchObject({
      subjectId: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/u),
      workspaceId: "workspace-1",
      decisionId: "decision-fixture",
      receiptId: evidence.authorization.authorizationContextDigest
    });
    expect(JSON.stringify(evidence)).not.toContain("grant-fixture");
    expect(JSON.stringify(metadata)).not.toContain("subject-fixture");
  });

  it("binds external service requests to the current authorized plugin operation", async () : Promise<any> => {
    const requestPluginExternalService: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      status: 200,
      data: { repository: { id: "synthetic-repository" } },
      pagination: { nextCursor: "cursor-2" },
      rateLimit: { remaining: 42 },
      receiptRef: "private-upstream-audit-record"
    }));
    const execute: any = vi.fn(async ({ host, input, signal }: Record<string, any>) : Promise<any> => ({
      methods: Object.keys(host.externalService || {}).sort(),
      result: await host.externalService.request({
        serviceRef: "svc_fixture",
        operationRef: input.operationRef || "demo.run",
        input: { owner: "fixture", repository: "demo" },
        idempotencyKey: "fixture-request-1",
        timeoutMs: 500
      }, { signal })
    }));
    const registry: any = createRegistry(enabledContributions({
      execute,
      requiredHostPorts: ["externalService"]
    }));
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        externalService: {
          requestPluginExternalService,
          forward: vi.fn()
        }
      }
    });
    const operation: any = registry.activeOperations[0];

    await expect(controller.executePluginOperation({
      operation,
      input: {},
      response: createCapturedResponse()
    })).rejects.toMatchObject({
      code: "plugin_external_service_current_authorization_required",
      message: "Plugin external service request failed."
    });
    expect(requestPluginExternalService).not.toHaveBeenCalled();

    const authorizedCall: any = (input?: any, response?: any, signal: any = null) : any => controller.executePluginOperation({
      operation,
      input,
      signal,
      request: {
        __meshrixToolRuntimeAuthorization: {
          ok: true,
          grant: {
            id: "grant-fixture",
            scopes: ["demo:run"],
            capabilities: ["cap:external:fixture"],
            metadata: { policyRevision: "policy-fixture" }
          },
          policy: { decisionId: "decision-fixture" }
        }
      },
      authSession: {
        user: {
          userId: "subject-fixture",
          tenantId: "tenant-fixture",
          scopes: ["gateway:read"]
        }
      },
      response
    });

    await expect(authorizedCall({ operationRef: "demo.other" }, createCapturedResponse()))
      .rejects.toMatchObject({ code: "plugin_external_service_binding_denied" });
    expect(requestPluginExternalService).not.toHaveBeenCalled();

    requestPluginExternalService.mockRejectedValueOnce(Object.assign(new Error("private provider detail"), {
      status: 502
    }));
    await expect(authorizedCall({}, createCapturedResponse())).rejects.toMatchObject({
      code: "plugin_external_service_request_failed",
      message: "Plugin external service request failed."
    });

    const response: any = createCapturedResponse();
    await authorizedCall({}, response);
    expect(parseCapturedResult({ operation, captured: response })).toEqual({
      methods: ["request"],
      result: {
        ok: true,
        status: 200,
        data: { repository: { id: "synthetic-repository" } },
        pagination: { nextCursor: "cursor-2" },
        rateLimit: { remaining: 42 },
        receiptRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      }
    });
    expect(requestPluginExternalService).toHaveBeenCalledTimes(2);
    const [boundRequest, boundOptions] = requestPluginExternalService.mock.calls[1];
    expect(boundRequest).toMatchObject({
      pluginId: "demo",
      operationId: "demo.run",
      serviceRef: "svc_fixture",
      operationRef: "demo.run",
      input: { owner: "fixture", repository: "demo" },
      idempotencyKey: "fixture-request-1",
      timeoutMs: 500,
      governance: {
        authorizationContextDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        riskDecisionRef: "decision-fixture",
        policyRevision: "policy-fixture"
      }
    });
    expect(boundOptions.subject).toMatchObject({
      subjectId: "subject-fixture",
      scopes: ["gateway:read", "demo:run"],
      dynamicCapabilities: ["cap:external:fixture"]
    });
    expect(JSON.stringify(parseCapturedResult({ operation, captured: response })))
      .not.toContain("private-upstream-audit-record");
  });

  it("seals declared base64 before plugin execution and preserves HTTP/MCP parity", async () : Promise<any> => {
    const raw: any = Buffer.alloc(70 * 1024, 0xa5);
    const encoded: any = raw.toString("base64");
    const observed: any[] = [];
    const store: any = vi.fn(async (request?: any) : Promise<any> => {
      const chunks: any[] = [];
      for await (const chunk of request.source) chunks.push(Buffer.from(chunk));
      const content: any = Buffer.concat(chunks);
      observed.push({ chunks: chunks.length, content, request });
      return {
        handle: `custody:fixture-${observed.length}`,
        contentDigest: createHash("sha256").update(content).digest("hex"),
        envelopeDigest: "e".repeat(64),
        byteCount: content.byteLength,
        replayed: false
      };
    });
    const execute: any = vi.fn(async ({ input, host }: Record<string, any>) : Promise<any> => ({
      ok: true,
      input,
      custodyMethods: Object.keys(host.opaqueArtifactCustody)
    }));
    const registry: any = opaqueRegistry({ execute });
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        opaqueArtifactCustody: { store, describe() : any {}, delete() : any {} }
      }
    });
    for (const transport of ["http", "mcp"]) {
      const response: any = createCapturedResponse();
      await controller.executePluginOperation({
        operation: registry.activeOperations[0],
        input: { contentBase64: encoded, label: "safe-metadata" },
        transport,
        requestId: `request:${transport}`,
        authSession: { user: { userId: "subject:fixture", tenantId: "tenant:fixture" } },
        context: { contributionRegistryWorkspaceId: "workspace:fixture" },
        response
      });
      const result: any = parseCapturedResult({ operation: registry.activeOperations[0], captured: response });
      expect(result.input).not.toHaveProperty("contentBase64");
      expect(result.input).toMatchObject({
        label: "safe-metadata",
        opaqueInput: {
          schemaVersion: "v0.0.1:plugin:opaque-input-handle-1",
          custodyRef: expect.stringMatching(/^custody:/u),
          contentDigest: createHash("sha256").update(raw).digest("hex"),
          envelopeDigest: "e".repeat(64),
          byteCount: raw.byteLength
        }
      });
      expect(result.custodyMethods).toEqual(["describe", "delete"]);
    }
    expect(observed).toHaveLength(2);
    expect(observed.every((entry?: any) : any => entry.chunks === Math.ceil(encoded.length / (64 * 1024)))).toBe(true);
    expect(observed.every((entry?: any) : any => entry.content.equals(raw))).toBe(true);
    expect(observed[0].request.ownerBinding).toEqual({
      subjectRef: "subject:fixture",
      tenantRef: "tenant:fixture",
      workspaceRef: "workspace:fixture"
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("fails opaque preprocessing closed on invalid transport, bounds, ownership, substitution, and receipt replay", async () : Promise<any> => {
    const execute: any = vi.fn();
    const validBytes: any = Buffer.from("opaque-input");
    const validDigest: any = createHash("sha256").update(validBytes).digest("hex");
    const store: any = vi.fn(async ({ source }: Record<string, any>) : Promise<any> => {
      for await (const _chunk of source) { /* consume once */ }
      return {
        handle: "custody:fixture",
        contentDigest: validDigest,
        envelopeDigest: "e".repeat(64),
        byteCount: validBytes.byteLength,
        replayed: true
      };
    });
    const registry: any = opaqueRegistry({ execute, contract: opaqueInputContract({ maxBytes: 32 }) });
    const removeStored: any = vi.fn();
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: { opaqueArtifactCustody: { store, describe() : any {}, delete: removeStored } }
    });
    const base: Record<string, any> = {
      operation: registry.activeOperations[0],
      authSession: { user: { userId: "subject:fixture", tenantId: "tenant:fixture" } },
      context: { contributionRegistryWorkspaceId: "workspace:fixture" },
      response: createCapturedResponse()
    };
    const denied: any[] = [
      [{ contentBase64: "not-base64" }, "plugin_opaque_input_base64_invalid", {}],
      [{ contentBase64: Buffer.alloc(33).toString("base64") }, "plugin_opaque_input_size_exceeded", {}],
      [{ contentBase64: validBytes.toString("base64"), opaqueInput: {} }, "plugin_opaque_input_target_forbidden", {}],
      [{ contentBase64: validBytes.toString("base64") }, "plugin_opaque_input_owner_binding_required", { authSession: null }],
      [{ contentBase64: validBytes.toString("base64") }, "plugin_opaque_input_owner_binding_required", { context: {} }],
      [{ contentBase64: validBytes.toString("base64"), tenantId: "spoofed" }, "plugin_opaque_input_owner_binding_required", {
        authSession: { user: { userId: "ordinary:fixture" } }
      }],
      [{ contentBase64: validBytes.toString("base64"), tenantId: "spoofed" }, "plugin_opaque_input_owner_binding_required", {
        authSession: { user: { type: "tool-grant", roleId: "tool-grant" } }
      }]
    ];
    for (const [input, code, patch] of denied) {
      await expect(controller.executePluginOperation({ ...base, ...patch, input, response: createCapturedResponse() }))
        .rejects.toMatchObject({ code });
    }

    store.mockResolvedValueOnce({
      handle: "custody:fixture",
      contentDigest: "0".repeat(64),
      envelopeDigest: "e".repeat(64),
      byteCount: validBytes.byteLength - 1,
      replayed: false
    });
    await expect(controller.executePluginOperation({
      ...base,
      input: { contentBase64: validBytes.toString("base64") },
      response: createCapturedResponse()
    })).rejects.toMatchObject({ code: "plugin_opaque_input_custody_receipt_invalid" });
    expect(removeStored).toHaveBeenCalledWith(expect.objectContaining({
      handle: "custody:fixture",
      ownerBinding: { subjectRef: "subject:fixture", tenantRef: "tenant:fixture", workspaceRef: "workspace:fixture" }
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("isolates opaque custody for an authenticated tool grant without a console tenant", async () : Promise<any> => {
    const bytes: any = Buffer.from("tool-grant-opaque-input");
    const ownerBindings: any[] = [];
    const execute: any = vi.fn(async ({ input }: Record<string, any>) : Promise<any> => ({ input }));
    const registry: any = opaqueRegistry({ execute });
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        opaqueArtifactCustody: {
          async store({ source, ownerBinding }: Record<string, any>) : Promise<any> {
            const chunks: any[] = [];
            for await (const chunk of source) chunks.push(Buffer.from(chunk));
            const content: any = Buffer.concat(chunks);
            ownerBindings.push(ownerBinding);
            return {
              handle: "custody:tool-grant-fixture",
              contentDigest: createHash("sha256").update(content).digest("hex"),
              envelopeDigest: "e".repeat(64),
              byteCount: content.byteLength,
              replayed: false
            };
          },
          describe() : any {},
          delete() : any {}
        }
      }
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: { contentBase64: bytes.toString("base64"), workspaceId: "workspace:fixture" },
      authSession: {
        user: {
          type: "tool-grant",
          roleId: "tool-grant",
          userId: "grant:fixture"
        }
      },
      response
    });
    const result: any = parseCapturedResult({ operation: registry.activeOperations[0], captured: response });
    expect(result.input).not.toHaveProperty("contentBase64");
    expect(ownerBindings).toEqual([{
      subjectRef: "grant:fixture",
      tenantRef: "tool-grant:grant:fixture",
      workspaceRef: "workspace:fixture"
    }]);
    expect(JSON.stringify(result)).not.toContain("tool-grant:grant:fixture");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("binds sandbox execution to the same authenticated custody owner", async () : Promise<any> => {
    const executeConfiguredOpaque: any = vi.fn(async (request?: any) : Promise<any> => ({ request }));
    const file: Record<string, any> = {
      path: "input.bin",
      custodyRef: "custody:fixture",
      contentDigest: "c".repeat(64),
      envelopeDigest: "e".repeat(64),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    };
    const promotionDigest: any = custodyPromotionSetDigest({ files: [file] });
    const execute: any = vi.fn(async ({ host }: Record<string, any>) : Promise<any> => host.sandboxExecution.executeConfiguredOpaque({
      principal: {
        subjectRef: "plugin-supplied-subject",
        tenantRef: "plugin-supplied-tenant",
        workspaceRef: "workspace:fixture",
        operationRef: "plugin-supplied-operation"
      }
    }, [{ handle: "opaque", promotionDigest, files: [{ ...file, digest: file.contentDigest }] }]));
    const registry: any = createRegistry(enabledContributions({
      execute,
      requiredHostPorts: ["sandboxExecution"]
    }));
    const controller: any = createPluginContributionController({
      registry,
      hostPorts: {
        sandboxExecution: { executeConfiguredOpaque }
      }
    });
    const response: any = createCapturedResponse();
    await controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: { workspaceId: "workspace:fixture" },
      request: {
        __meshrixToolRuntimeAuthorization: {
          ok: true,
          grant: { id: "grant:fixture", metadata: { policyRevision: "policy:fixture" } },
          policy: { decisionId: "risk:fixture" }
        }
      },
      authSession: {
        user: {
          userId: "subject:fixture",
          tenantId: "tenant:fixture"
        }
      },
      response
    });
    const [boundRequest, boundInputs] = executeConfiguredOpaque.mock.calls[0];
    expect(boundRequest).toMatchObject({
      principal: {
        subjectRef: "subject:fixture",
        tenantRef: "tenant:fixture",
        workspaceRef: "workspace:fixture",
        operationRef: registry.activeOperations[0].id
      },
      governance: { grantRef: "grant:fixture", riskDecisionRef: "risk:fixture", policyRevision: "policy:fixture", authorized: true, current: true }
    });
    expect(boundInputs[0]).toMatchObject({
      promotionDigest,
      authorizationDigest: custodyPromotionAuthorizationDigest({
        promotionDigest,
        ownerBinding: boundRequest.principal,
        governance: boundRequest.governance
      })
    });

    await expect(controller.executePluginOperation({
      operation: registry.activeOperations[0],
      input: {},
      authSession: { user: { userId: "subject:fixture" } },
      response: createCapturedResponse()
    })).rejects.toThrow(/authenticated subject, tenant, and workspace binding/u);
    expect(executeConfiguredOpaque).toHaveBeenCalledTimes(1);
  });

  it("keeps external authentication in the pre-execution verifier phase", async () : Promise<any> => {
    const execute: any = vi.fn();
    const verifyExternalAuth: any = vi.fn(async () : Promise<any> => ({
      ok: false,
      status: 503,
      reasonCode: "fixture_busy",
      retryable: true
    }));
    const contributions: any = enabledContributions({
      definition: definition("demo.run", {
        externalAuth: true,
        externalAuthVerifier: { method: "ignored" }
      }),
      execute,
      verifyExternalAuth,
      requiredHostPorts: []
    });
    const registry: any = createRegistry(contributions);
    const operation: any = registry.activeOperations[0];
    expect(operation.externalAuthVerifier).toEqual({
      controller: "plugin",
      method: "verifyPluginExternalAuth"
    });
    const result: any = await createPluginContributionController({ registry }).verifyPluginExternalAuth({
      operation,
      input: {}
    });
    expect(result).toMatchObject({ ok: false, status: 503, retryable: true });
    expect(verifyExternalAuth.mock.calls[0][0].call).toMatchObject({
      schemaVersion: "v0.0.1:plugin:call-context-1",
      transport: "internal"
    });
    expect(verifyExternalAuth.mock.calls[0][0].call).not.toHaveProperty("request");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps disabled contributions absent and rejects core takeover", () : any => {
    const plugin: any = manifest();
    const empty: any = Object.fromEntries([
      "operations", "routes", "mcpTools", "consoleEntries", "stateMachines", "verifierHooks"
    ].map((kind?: any) : any => [kind, {}]));
    const disabled: any = createPluginContributionRegistry({
      manifests: [plugin],
      loadedPlugins: [],
      contributions: empty,
      coreOperations: [],
      activeFeatureIds: ["core-platform"]
    });
    expect(disabled.activeOperations).toEqual([]);
    expect(disabled.publicRuntime().consoleEntries).toEqual([]);
    expect(() : any => disabled.requireOperation("demo.run")).toThrow(/not enabled/u);
    expect(() : any => createRegistry(enabledContributions(), {
      coreOperations: [definition()]
    })).toThrow(/conflicts with a plugin-owned operation claim/u);
  });

  it("rejects unknown fields, mismatched routes, duplicate MCP bindings, and undeclared ports", () : any => {
    expect(() : any => createRegistry(enabledContributions({ typoExecute: () : any => {} }))).toThrow(/unsupported field/u);
    expect(() : any => createRegistry(enabledContributions({ requiredHostPorts: ["runtime"] }))).toThrow(/unsupported host port/u);
    const mismatchedOpaqueContract: any = opaqueInputContract({ maxBytes: 2048 });
    expect(() : any => createRegistry(enabledContributions({
      requiredHostPorts: ["opaqueArtifactCustody"],
      opaqueInputPreprocessing: mismatchedOpaqueContract
    }), {
      manifests: [manifest({ opaqueInputPreprocessing: { "demo.run": opaqueInputContract({ maxBytes: 1024 }) } })]
    })).toThrow(/must match its manifest/u);
    expect(() : any => createRegistry(enabledContributions({
      requiredHostPorts: ["agentWorkspace"],
      hostPathInputPreprocessing: hostPathInputContract({ targetField: "otherSelectionRef" })
    }), {
      manifests: [manifest({ hostPathInputPreprocessing: { "demo.run": hostPathInputContract() } })]
    })).toThrow(/must match its manifest/u);
    expect(() : any => createRegistry(enabledContributions({
      requiredHostPorts: ["securityPermissions"],
      hostPathInputPreprocessing: hostPathInputContract()
    }), {
      manifests: [manifest({ hostPathInputPreprocessing: { "demo.run": hostPathInputContract() } })]
    })).toThrow(/requires agentWorkspace/u);
    const wrongRoute: any = enabledContributions();
    wrongRoute.routes["demo.run.http"] = record("demo", "routes", "demo.run.http", { operationId: "missing" });
    expect(() : any => createRegistry(wrongRoute)).toThrow(/unavailable operation/u);
    const duplicateTool: any = enabledContributions();
    duplicateTool.mcpTools["meshrix.demo.alias"] = record("demo", "mcpTools", "meshrix.demo.alias", {
      operationId: "demo.run",
      outlet: "meshrix.gateway"
    });
    expect(() : any => createRegistry(duplicateTool, {
      manifests: [manifest({ mcpTools: ["meshrix.demo.run", "meshrix.demo.alias"] })]
    })).toThrow(/more than one MCP tool binding/u);
  });

  it("requires plugin-owned feature, toolset, and resource metadata without core inference", () : any => {
    expect(() : any => createRegistry(enabledContributions({
      definition: definition("demo.run", { featureId: "" })
    }))).toThrow(/explicit featureId/u);
    expect(() : any => createRegistry(enabledContributions({
      definition: definition("demo.run", { featureId: "undeclared-feature" })
    }))).toThrow(/undeclared feature/u);
    expect(() : any => createRegistry(enabledContributions({
      definition: definition("demo.run", { toolsets: [] })
    }))).toThrow(/at least one explicit toolset/u);
    expect(() : any => createRegistry(enabledContributions({
      definition: definition("demo.run", { resource: undefined })
    }))).toThrow(/resource must be an object/u);
    expect(() : any => createRegistry(enabledContributions({
      definition: definition("demo.run", {
        resourceContext: {
          capabilityDomain: "demo",
          resourceKind: "different_task",
          capabilityVerb: "run",
          effectKind: "write",
          fieldMap: {}
        }
      })
    }))).toThrow(/must match exactly/u);
  });

  it("requires one consistent validated descriptor for each plugin-defined MCP outlet", () : any => {
    const valid: any = enabledContributions();
    valid.mcpTools["meshrix.demo.run"] = record("demo", "mcpTools", "meshrix.demo.run", {
      operationId: "demo.run",
      outlet: "meshrix.demo",
      outletDescriptor: outletDescriptor()
    });
    const registry: any = createRegistry(valid);
    expect(registry.activeOperations[0]._meta).toMatchObject({
      mcpOutlet: "meshrix.demo",
      mcpOutletDescriptor: { toolName: "meshrix.demo", architectureCategory: "Demo" }
    });

    const missing: any = enabledContributions();
    missing.mcpTools["meshrix.demo.run"] = record("demo", "mcpTools", "meshrix.demo.run", {
      operationId: "demo.run",
      outlet: "meshrix.demo"
    });
    expect(() : any => createRegistry(missing)).toThrow(/requires an outletDescriptor/u);

    const mismatched: any = enabledContributions();
    mismatched.mcpTools["meshrix.demo.run"] = record("demo", "mcpTools", "meshrix.demo.run", {
      operationId: "demo.run",
      outlet: "meshrix.demo",
      outletDescriptor: outletDescriptor("meshrix.other")
    });
    expect(() : any => createRegistry(mismatched)).toThrow(/toolName must match outlet/u);

    const conflicting: any = enabledContributions();
    conflicting.mcpTools["meshrix.demo.run"] = record("demo", "mcpTools", "meshrix.demo.run", {
      operationId: "demo.run",
      outlet: "meshrix.demo",
      outletDescriptor: outletDescriptor()
    });
    conflicting.mcpTools["meshrix.demo.alias"] = record("demo", "mcpTools", "meshrix.demo.alias", {
      operationId: "demo.run",
      outlet: "meshrix.demo",
      outletDescriptor: { ...outletDescriptor(), title: "Conflicting Demo" }
    });
    expect(() : any => createRegistry(conflicting, {
      manifests: [manifest({ mcpTools: ["meshrix.demo.run", "meshrix.demo.alias"] })]
    })).toThrow(/conflicting descriptors/u);
  });

  it("projects only validated enabled-plugin gateway route descriptors", () : any => {
    const contributions: any = enabledContributions();
    contributions.routes["demo.run.http"] = record("demo", "routes", "demo.run.http", {
      operationId: "demo.run",
      gateway: {
        routeId: "demo",
        match: "prefix",
        path: "/api/demo",
        trafficClass: "demo",
        streaming: false,
        sticky: false,
        bodyLimit: "8m"
      }
    });
    expect(createRegistry(contributions).publicRuntime().routes[0]).toMatchObject({
      pluginId: "demo",
      gateway: {
        routeId: "demo",
        path: "/api/demo",
        trafficClass: "demo"
      }
    });

    const invalid: any = enabledContributions();
    invalid.routes["demo.run.http"] = record("demo", "routes", "demo.run.http", {
      operationId: "demo.run",
      gateway: {
        routeId: "demo",
        match: "prefix",
        path: "/api/unrelated",
        trafficClass: "demo",
        bodyLimit: "8m"
      }
    });
    expect(() : any => createRegistry(invalid)).toThrow(/gateway descriptor is invalid/u);
  });
});
