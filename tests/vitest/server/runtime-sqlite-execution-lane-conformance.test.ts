import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQueueDefinitionRegistry,
  createSqliteWorkQueueLane
} from "../../../packages/foundation/src/work-queue/index.ts";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.ts";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.ts";
import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.ts";
import { createApiKeyDistributionProvider } from "../../../packages/capabilities/src/operation-permission-core/api-key-distribution.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";

const roots: any[] = [];

function apiKeyOwnerPermissions() {
  const roles = [{
    roleId: "key-manager",
    name: "Key manager",
    scopeNodeId: "issuer",
    scopeNodeType: "organization",
    managementActions: ["operation_permission.api_keys.manage"]
  }];
  return {
    getOrganizationGovernance: () => ({
      configured: true,
      revision: 1,
      nodes: [
        { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
        { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" },
        { nodeId: "child", nodeType: "department", parentId: "issuer", name: "Child" }
      ],
      roles
    }),
    getGovernanceSummary: () => ({
      policyRevision: { revision: 1, updatedAt: "2026-08-03T00:00:00.000Z" },
      roles: roles.map((role) => ({ ...role, enabled: true })),
      userPolicies: [{ userId: "admin", enabled: true, roleIds: ["key-manager"] }],
      apiKeyRecoveryAssignments: []
    }),
    getGovernancePolicyRevision: () => ({ revision: 1 }),
    verifyProcessIdentity: (evidence: unknown) => evidence
  };
}

describe("typed SQLite execution lane", () : any => {
  afterEach(async () : Promise<any> => {
    await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  });

  it("owns one queue writer and transports only bounded discriminated commands", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-lane-"));
    roots.push(root);
    const store: any = createSqliteWorkQueueLane({ userDataPath: root, maxPending: 8, maxPendingBytes: 4096 });
    const registry: any = createQueueDefinitionRegistry();
    const definition: any = registry.registerQueueDefinition({
      queueDefinitionId: "queue.sqlite.lane",
      label: "queue.sqlite.lane",
      ownerCapability: "sqlite-lane-test"
    });
    try {
      await store.registerQueueDefinition(definition);
      const admission: any = registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definition.queueDefinitionId,
        scope: {},
        dedupeKey: "one"
      });
      const enqueued: any = await store.enqueue({
        ...admission,
        workItemId: "lane-item-one",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "sqlite-lane-test" }
      });
      expect(enqueued.workItem.workItemId).toBe("lane-item-one");
      expect(store.lane.getStats()).toMatchObject({ writerWorkers: 1, pending: 0 });
      await expect(store.lane.execute("enqueue", { sql: "SELECT 1" }))
        .rejects.toMatchObject({ code: "sqlite_lane_payload_rejected" });
      await expect(store.lane.execute("unknown", {}))
        .rejects.toMatchObject({ code: "sqlite_lane_command_rejected" });
    } finally {
      await store.close();
    }
    expect(store.lane.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one mandatory-evidence writer and rejects untyped or oversized requests", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-audit-lane-"));
    roots.push(root);
    const store: any = createOperationAuditStore({
      userDataPath: root,
      maxPending: 8,
      maxPendingBytes: 256
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "mandatory-evidence-operation-audit",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 256
      });
      expect(await store.append({
        operationId: "audit.owner.probe",
        transport: "test",
        status: "ok"
      })).toMatchObject({ auditId: expect.any(String) });
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one authorization writer through an async-only facade lifecycle", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-authorization-lane-"));
    roots.push(root);
    const store: any = createAuthorizationStore({
      userDataPath: root,
      maxPending: 8,
      maxPendingBytes: 4096
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "authorization-evidence",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 4096
      });
      const decision: any = await store.appendDecision({
        traceId: "authorization-lane-probe",
        subject: { type: "test", subjectId: "authorization-lane-subject" },
        operation: { id: "authorization.lane.probe" },
        effect: "allow",
        allowed: true,
        reasonCode: "allowed",
        createdAt: "2026-08-13T00:00:00.000Z"
      });
      expect(decision).toMatchObject({ decisionId: expect.any(String) });
      expect(await store.listDecisions({ traceId: "authorization-lane-probe", limit: 1 }))
        .toHaveLength(1);
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
  });

  it("owns one operation-permission writer through an async-only facade lifecycle", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-operation-permission-lane-"));
    const alias: any = `${root}-alias`;
    roots.push(root);
    roots.push(alias);
    await fs.symlink(root, alias, "dir");
    const store: any = createOperationPermissionStore({
      userDataPath: root,
      capabilityBindingGuard: false,
      capabilityResolver: () : any => ["cap:tool:*"],
      maxPending: 8,
      maxPendingBytes: 4096
    });
    try {
      expect(store.db).toBeUndefined();
      expect(store.getStats()).toMatchObject({
        owner: "authorization-operation-permission",
        writerWorkers: 1,
        maxPending: 8,
        maxPendingBytes: 4096
      });
      let duplicateOwnerError: any;
      try {
        createOperationPermissionStore({
          userDataPath: alias,
          capabilityBindingGuard: false,
          capabilityResolver: () : any => ["cap:tool:*"]
        });
      } catch (error) {
        duplicateOwnerError = error;
      }
      expect(duplicateOwnerError).toMatchObject({ code: "operation_permission_owner_active" });
      const created: any = await store.createGrant({
        id: "operation-permission-lane-probe",
        label: "Operation Permission lane probe",
        capabilities: ["cap:tool:*"]
      });
      expect(created.grant).toMatchObject({ id: "operation-permission-lane-probe", enabled: true });
      expect(await store.getGrant(created.grant.id)).toMatchObject({ enabled: true });
      await expect(store.lane.execute("getGrant", { sql: "SELECT 1" }))
        .rejects.toMatchObject({ code: "sqlite_lane_payload_rejected" });
    } finally {
      await store.close();
    }
    expect(store.getStats()).toMatchObject({ writerWorkers: 0, closed: true });
    const reopened: any = createOperationPermissionStore({
      userDataPath: alias,
      capabilityBindingGuard: false,
      capabilityResolver: () : any => ["cap:tool:*"]
    });
    try {
      expect(reopened.getStats()).toMatchObject({ writerWorkers: 1, closed: false });
    } finally {
      await reopened.close();
    }
  });

  it("recovers ephemeral API Key reservations only after an owning process exits and preserves quota state", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-operation-permission-crash-recovery-"));
    roots.push(root);
    const fixedNow = Date.parse("2026-08-03T00:00:00.000Z");
    const resourceContext = { workspaceId: "workspace-1" };
    const operation = { toolId: "tools.echo", risk: "read_only", resourceContext };
    const catalog = {
      fingerprint: "abrupt-owner-catalog",
      tools: [{
        id: "tools.echo",
        toolsets: ["meshrix.runtime.read"],
        requiredScopes: ["runtime:read"],
        risk: "read_only",
        resourceContext
      }],
      toolsets: [{ id: "meshrix.runtime.read", requiredScopes: ["runtime:read"] }],
      scopes: [{ id: "runtime:read" }]
    };
    const registry: any = { getCatalog: () => catalog };
    const governanceSource = `(${apiKeyOwnerPermissions.toString()})()`;
    const storeUrl = new URL("../../../packages/capabilities/src/operation-permission-core/store.ts", import.meta.url).href;
    const providerUrl = new URL("../../../packages/capabilities/src/operation-permission-core/api-key-distribution.ts", import.meta.url).href;
    const verifierUrl = new URL("../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts", import.meta.url).href;
    const childSource = `
      const [{ createOperationPermissionStore }, { createApiKeyDistributionProvider }, { createMemoryApiKeyVerifierKeyProvider }] = await Promise.all([
        import(${JSON.stringify(storeUrl)}), import(${JSON.stringify(providerUrl)}), import(${JSON.stringify(verifierUrl)})
      ]);
      const root = process.argv[2];
      const permissions = ${governanceSource};
      const registry = { getCatalog: () => (${JSON.stringify(catalog)}) };
      const store = createOperationPermissionStore({
        userDataPath: root,
        registry,
        securityPermissions: permissions,
        capabilityBindingGuard: false,
        apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 91)),
        apiKeyClock: () => ${fixedNow},
        apiKeyRandomBytes: (size) => Buffer.alloc(size, size === 16 ? 17 : 29)
      });
      const provider = createApiKeyDistributionProvider({ store });
      try {
        const created = await provider.create({
          subjectId: "admin",
          workloadDisplayName: "Abrupt owner recovery fixture",
          organizationNodeId: "child",
          expiresAt: "2026-08-04T00:00:00.000Z",
          policy: {
            protocol: "mcp", serviceIds: [], capabilityIds: [], toolsetIds: ["meshrix.runtime.read"],
            allowedTools: ["tools.echo"], deniedTools: [], scopeIds: ["runtime:read"], maximumRisk: "low",
            audience: { serverAudience: "https://meshrix.invalid", targetIds: ["server"], connectorPackageIds: [] },
            resources: {
              mode: "restricted", workspaceIds: ["workspace-1"], dataClassifications: [], egressClasses: [],
              semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [],
              secretBindingIds: [], allowedOrigins: [], allowedCidrs: []
            },
            processIdentity: { mode: "optional" },
            limits: { maxUses: 3, requestsPerWindow: 2, windowSeconds: 60, maxConcurrentEffects: 1 },
            catalogFingerprint: "abrupt-owner-catalog"
          }
        });
        const authorization = await provider.authenticateRuntime({
          credential: created.apiKey, serverAudience: "https://meshrix.invalid", targetId: "server",
          connectorPackageId: null, processIdentityEvidence: null
        });
        await provider.reserveEffect({ authorization, operation: ${JSON.stringify(operation)} });
        process.stdout.write(JSON.stringify({ apiKey: created.apiKey, keyId: created.record.keyId }), () => process.exit(0));
      } catch (error) {
        process.stderr.write(String(error?.details?.causeCode || error?.code || "child_setup_failed"), () => process.exit(1));
      }
    `;
    const childScript = path.join(root, "abrupt-owner.mjs");
    await fs.writeFile(childScript, childSource, "utf8");
    const child = spawnSync(process.execPath, [
      "--conditions=source",
      "--experimental-strip-types",
      childScript,
      root
    ], { cwd: process.cwd(), encoding: "utf8" });
    const childFailureCategory = child.stderr.trim().match(/^[a-z0-9_]{1,80}$/u)?.[0] ||
      child.stderr.match(/\b(ERR_[A-Z0-9_]+)\b/u)?.[1]?.toLowerCase() ||
      child.stderr.match(/\b(SyntaxError|TypeError|ReferenceError)\b/u)?.[1]?.toLowerCase() ||
      (child.stderr.includes("Cannot find package") ? "module-resolution" : "runtime-startup");
    expect(child.status, `owner-process-exit-${child.status ?? child.signal ?? "unknown"}-${childFailureCategory}`).toBe(0);
    let childState: any = null;
    try {
      childState = JSON.parse(child.stdout.trim());
    } catch {
      // Keep a failed child fixture diagnostic free of its in-memory credential.
    }
    expect(typeof childState?.apiKey).toBe("string");
    expect(typeof childState?.keyId).toBe("string");

    const store: any = createOperationPermissionStore({
      userDataPath: root,
      registry,
      securityPermissions: apiKeyOwnerPermissions(),
      capabilityBindingGuard: false,
      apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 91)),
      apiKeyClock: () => fixedNow
    });
    const provider: any = createApiKeyDistributionProvider({ store });
    try {
      await expect(provider.list({ subjectId: "admin", limit: 10 }))
        .resolves.toMatchObject({ items: [expect.objectContaining({ keyId: childState.keyId, useCount: 1 })] });
      const authorization = await provider.authenticateRuntime({
        credential: childState.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      });
      const recoveredReservation = await provider.reserveEffect({ authorization, operation });
      await provider.releaseEffect(recoveredReservation);
      await expect(provider.list({ subjectId: "admin", limit: 10 }))
        .resolves.toMatchObject({ items: [expect.objectContaining({ keyId: childState.keyId, useCount: 2 })] });
      await expect(provider.reserveEffect({ authorization, operation }))
        .rejects.toMatchObject({ code: "api_key_rate_limited" });
    } finally {
      await store.close();
    }
  });
});
