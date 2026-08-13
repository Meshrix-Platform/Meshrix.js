import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConsoleApiKeyDistributionController } from "../../../apps/console/composables/console-api-key-distribution-controller";
import type {
  ApiKeyIssuerScopes,
  ApiKeyOneTimeResult,
  ApiKeyPolicy,
  ApiKeyRecord,
} from "../../../apps/console/lib/api-key-distribution-client";
import type { OperationPermissionCatalog } from "../../../apps/console/lib/types/operation-permission";

const ONE_TIME_SENTINEL = "opaque-one-time-credential";

const policy: ApiKeyPolicy = {
  protocol: "mcp",
  serviceIds: ["service-a"], capabilityIds: ["capability-a"], toolsetIds: ["toolset-a"],
  allowedTools: ["tool.read"], deniedTools: [], scopeIds: ["scope-a"], maximumRisk: "low",
  audience: { serverAudience: "server-a", targetIds: ["target-a"], connectorPackageIds: [] },
  resources: {
    mode: "restricted", workspaceIds: ["workspace-a"], dataClassifications: [], egressClasses: [],
    semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [],
    secretBindingIds: [], allowedOrigins: [], allowedCidrs: [],
  },
  processIdentity: { mode: "optional" },
  limits: { maxUses: 10, requestsPerWindow: 3, windowSeconds: 60, maxConcurrentEffects: 1 },
  catalogFingerprint: "catalog-a",
};

const catalog: OperationPermissionCatalog = {
  schemaVersion: "1",
  generatedAt: "2026-08-01T00:00:00.000Z",
  fingerprint: "catalog-a",
  scopes: [{ id: "scope-a", label: "Scope A", description: "" }],
  toolsets: [{ id: "toolset-a", label: "Toolset A", requiredScopes: ["scope-a"], maxRisk: "read_only" }],
  profiles: [{
    id: "profile-a",
    label: "Reader",
    agentType: "reader",
    toolsets: ["toolset-a"],
    toolAllow: ["tool.read"],
    toolDeny: ["tool.write"],
    maxRisk: "safe_write",
    approvalPolicy: "",
    concurrencyLimit: 1,
    sandboxPolicy: "",
    auditTags: [],
  }],
  tools: [
    {
      id: "tool.read", version: "1", label: "Read Tool", description: "", owner: "core", source: "core",
      operationId: "op.read", handlerId: "h", toolsets: ["toolset-a"], requiredScopes: ["scope-a"],
      risk: "read_only", readOnly: true, destructive: false,
      concurrency: { workloadClass: "light", maxParallel: 64, cost: 1 }, requiresApproval: false,
      approvalScope: "", timeoutMs: 1, maxResultBytes: 1, status: "active", tags: [],
      serviceId: "service-a", capabilityId: "capability-a",
    },
    {
      id: "tool.write", version: "1", label: "Write Tool", description: "", owner: "core", source: "core",
      operationId: "op.write", handlerId: "h", toolsets: ["toolset-a"], requiredScopes: ["scope-a"],
      risk: "safe_write", readOnly: false, destructive: false,
      concurrency: { workloadClass: "standard", maxParallel: 16, cost: 2 }, requiresApproval: false,
      approvalScope: "", timeoutMs: 1, maxResultBytes: 1, status: "active", tags: [],
      serviceId: "service-a", capabilityId: "capability-b",
    },
  ],
};

function record(revision = 1, status: ApiKeyRecord["status"] = "active"): ApiKeyRecord {
  return {
    keyId: "key-public-id", displayPrefix: "mxak1.pub…", credentialFingerprint: "fingerprint-a",
    workloadPrincipalId: "workload-principal-a", workloadDisplayName: "Build worker",
    organizationNodeId: "organization-a", organizationBreadcrumb: ["Group", "Organization A"],
    policy, policyFingerprint: "policy-a", status, lifecycleRevision: revision, useCount: 2,
    createdAt: "2026-08-01T00:00:00.000Z", rotatedAt: null, revokedAt: null,
    expiresAt: "2026-09-01T00:00:00.000Z",
  };
}

const scopes: ApiKeyIssuerScopes & { catalogFingerprint: string; serverAudience: string } = {
  organizationRevision: 1, authorizationRevision: 2, catalogFingerprint: "catalog-a", serverAudience: "server-a",
  eligibleRoots: [{ nodeId: "organization-a", name: "Organization A", breadcrumb: ["Group", "Organization A"], nodeType: "organization" }],
  eligibleNodes: [{ nodeId: "organization-a", name: "Organization A", breadcrumb: ["Group", "Organization A"], nodeType: "organization" }],
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    getIssuerScopes: vi.fn(async () => scopes),
    list: vi.fn(async () => ({ records: [record()], nextCursor: null })),
    create: vi.fn(async (): Promise<ApiKeyOneTimeResult> => ({ record: record(), apiKey: ONE_TIME_SENTINEL })),
    rotate: vi.fn(async (): Promise<ApiKeyOneTimeResult> => ({ record: record(2), apiKey: ONE_TIME_SENTINEL })),
    revoke: vi.fn(async () => record(2, "revoked")),
    getCatalog: vi.fn(async () => catalog),
    ...overrides,
  };
}

function completeDraft(controller: ReturnType<typeof useConsoleApiKeyDistributionController>): void {
  Object.assign(controller.draft.value, {
    workloadDisplayName: "Build worker", organizationNodeId: "organization-a", expiresAt: "2026-09-01T08:00",
    selectedToolsetIds: ["toolset-a"], selectedTargetIds: ["codex"],
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("API key distribution console", () => {
  it("keeps create plaintext only in ephemeral reveal state and clears every exit", async () => {
    const api = client();
    const storageWrite = vi.fn();
    const historyWrite = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { setItem: storageWrite },
      sessionStorage: { setItem: storageWrite },
      history: { pushState: historyWrite, replaceState: historyWrite },
    });
    const controller = useConsoleApiKeyDistributionController({
      client: api as any, confirmAction: vi.fn(async () => true), copyText: vi.fn(async () => true),
    });

    await controller.refresh();
    completeDraft(controller);
    expect(controller.draftValid.value).toBe(true);
    await controller.create();
    expect(controller.oneTimeSecret.value).toBe(ONE_TIME_SENTINEL);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();

    await controller.copySecret();
    expect(controller.copied.value).toBe(true);
    controller.dismissSecret(true);
    expect(controller.oneTimeSecret.value).toBe("");
    expect(controller.status.value).toMatch(/永久关闭|permanently dismissed/u);

    await controller.create();
    expect(controller.oneTimeSecret.value).toBe(ONE_TIME_SENTINEL);
    await controller.refresh();
    expect(controller.oneTimeSecret.value).toBe("");
    expect(JSON.stringify(controller.records.value)).not.toContain(ONE_TIME_SENTINEL);
  });

  it("selects toolsets as the primary choice and infers allowed tools plus scopes", async () => {
    const api = client();
    const controller = useConsoleApiKeyDistributionController({
      client: api as any, confirmAction: vi.fn(async () => true),
    });
    await controller.refresh();
    completeDraft(controller);
    expect(controller.draft.value.allowedTools).toEqual(["tool.read", "tool.write"]);
    expect(controller.toolsetOptions.value.map((option) => option.value)).toEqual(["toolset-a"]);
    expect(controller.inferredPolicy.value).toEqual({
      toolsetIds: ["toolset-a"],
      scopeIds: ["scope-a"],
      serviceIds: ["service-a"],
      capabilityIds: ["capability-a", "capability-b"],
      minimumRisk: "medium",
    });

    await controller.create();
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      policy: expect.objectContaining({
        allowedTools: ["tool.read", "tool.write"],
        deniedTools: [],
        toolsetIds: ["toolset-a"],
        scopeIds: ["scope-a"],
        serviceIds: ["service-a"],
        capabilityIds: ["capability-a", "capability-b"],
        catalogFingerprint: "catalog-a",
        processIdentity: { mode: "optional" },
        audience: expect.objectContaining({
          serverAudience: "server-a",
          targetIds: ["codex"],
          connectorPackageIds: [],
        }),
        resources: expect.objectContaining({
          mode: "unrestricted",
        }),
        limits: {
          maxUses: 2_000_000_000,
          requestsPerWindow: 2_000_000_000,
          windowSeconds: 60,
          maxConcurrentEffects: 10_000,
        },
      }),
    }));
  });

  it("applies a catalog profile to prefill toolsets", async () => {
    const controller = useConsoleApiKeyDistributionController({ client: client() as any });
    await controller.refresh();
    controller.applyProfile("profile-a");
    expect(controller.draft.value.selectedToolsetIds).toEqual(["toolset-a"]);
    expect(controller.draft.value.allowedTools).toEqual(["tool.read", "tool.write"]);
    expect(controller.draft.value.maximumRisk).toBe("medium");
  });

  it("imports JSON draft config into the create form without creating a key", async () => {
    const api = client();
    const controller = useConsoleApiKeyDistributionController({ client: api as any });
    await controller.refresh();
    controller.importDraftConfig({
      workloadDisplayName: "Imported worker",
      organizationNodeId: "organization-a",
      expiresAt: "2026-09-01T08:00",
      selectedToolsetIds: ["toolset-a"],
      selectedTargetIds: ["codex"],
      resourcesUnrestricted: true,
    });
    expect(controller.draft.value.workloadDisplayName).toBe("Imported worker");
    expect(controller.draft.value.selectedToolsetIds).toEqual(["toolset-a"]);
    expect(controller.draft.value.allowedTools).toEqual(["tool.read", "tool.write"]);
    expect(controller.draft.value.selectedTargetIds).toEqual(["codex"]);
    expect(controller.status.value).toMatch(/JSON|表单|form/u);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("blocks create when catalog fingerprint disagrees with issuer authority", async () => {
    const controller = useConsoleApiKeyDistributionController({
      client: client({
        getCatalog: vi.fn(async () => ({ ...catalog, fingerprint: "catalog-b" })),
      }) as any,
      confirmAction: vi.fn(async () => true),
    });
    expect(await controller.refresh()).toBe(false);
    completeDraft(controller);
    expect(controller.catalogMismatch.value).toBe(true);
    expect(controller.draftValid.value).toBe(false);
    expect(controller.error.value).toMatch(/目录|catalog/u);
  });

  it("binds rotate and revoke to the displayed lifecycle revision and never offers archive semantics", async () => {
    const api = client();
    const confirmAction = vi.fn(async () => true);
    const controller = useConsoleApiKeyDistributionController({ client: api as any, confirmAction });
    await controller.refresh();

    await controller.rotate(controller.records.value[0]);
    expect(api.rotate).toHaveBeenCalledWith("key-public-id", 1);
    expect(controller.oneTimeSecret.value).toBe(ONE_TIME_SENTINEL);

    await controller.revoke(controller.records.value[0]);
    expect(controller.oneTimeSecret.value).toBe("");
    expect(api.revoke).toHaveBeenCalledWith("key-public-id", 2, "administrator_revoked");
    expect(controller.records.value[0].status).toBe("revoked");

    const view = readFileSync(new URL("../../../apps/console/views/admin/ApiKeyDistributionView.vue", import.meta.url), "utf8");
    expect(view).toContain("usePageRefreshHandler");
    expect(view).toContain("FeatureToggle");
    expect(view).toContain("MultiChoiceCardGroup");
    expect(view).toContain("OptionBar");
    expect(view).toContain("ConsoleDescriptionList");
    expect(view).toContain("selectedToolsetIds");
    expect(view).toContain('layout="list"');
    expect(view).toContain("调用限制");
    expect(view).toContain("每分钟调用次数");
    expect(view).toContain("最大并发量");
    expect(view).toContain("三步完成 Agent MCP 接入");
    expect(view).toContain('data-testid="agent-setup-agent-step"');
    expect(view).toContain('data-testid="agent-target-select"');
    expect(view).toContain("targetId ? [targetId] : []");
    expect(view).toContain('data-testid="agent-setup-access-step"');
    expect(view).toContain('data-testid="agent-setup-review-step"');
    expect(view).toContain("高级设置");
    expect(view).toContain("允许访问全部资源");
    expect(view).not.toContain("连接器包 ID");
    expect(view).not.toContain("进程身份与使用限制");
    expect(view).not.toContain("最多使用次数");
    expect(view).not.toContain("排除个别工具");
    expect(view).not.toContain("deniedTools");
    expect(view).not.toContain("出口类别");
    expect(view).not.toContain("语义族");
    expect(view).not.toContain('v-model="draft.allowedTools"');
    expect(view).not.toContain('v-model="draft.serviceIds"');
    expect(view).not.toContain('v-model="draft.toolsetIds"');
    expect(view).not.toMatch(/>\s*(Refresh|刷新)\s*</);
    expect(view).not.toMatch(/@click="archive|archive\(/i);
  });

  it("uses only readable eligible nodes and hides authority when issuer scope is empty", async () => {
    const controller = useConsoleApiKeyDistributionController({ client: client() as any });
    await controller.refresh();
    expect(controller.nodes.value.map((node) => node.name)).toEqual(["Organization A"]);
    expect(controller.eligible.value).toBe(true);

    const restricted = useConsoleApiKeyDistributionController({
      client: client({ getIssuerScopes: vi.fn(async () => ({ ...scopes, eligibleNodes: [] })) }) as any,
    });
    await restricted.refresh();
    expect(restricted.eligible.value).toBe(false);
  });

  it("uses a dedicated unavailable state when the first refresh cannot confirm authority", async () => {
    const unavailable = useConsoleApiKeyDistributionController({
      client: client({ getIssuerScopes: vi.fn(async () => { throw new Error("temporarily unavailable"); }) }) as any,
    });

    expect(await unavailable.refresh()).toBe(false);
    expect(unavailable.scopes.value).toBeNull();
    expect(unavailable.eligible.value).toBe(false);
    expect(unavailable.error.value).toBeTruthy();

    const view = readFileSync(new URL("../../../apps/console/views/admin/ApiKeyDistributionView.vue", import.meta.url), "utf8");
    expect(view).toContain('data-access="unavailable"');
    expect(view.indexOf('data-access="unavailable"')).toBeLessThan(view.indexOf('data-access="restricted-empty"'));
  });

  it("preserves the last confirmed scope snapshot across a transient refresh failure", async () => {
    const api = client();
    const controller = useConsoleApiKeyDistributionController({ client: api as any });
    await controller.refresh();
    const previousRecord = controller.records.value[0];
    api.list.mockRejectedValueOnce(new Error("temporarily unavailable"));

    expect(await controller.refresh()).toBe(false);
    expect(controller.error.value).toBeTruthy();
    expect(controller.scopes.value).toEqual(scopes);
    expect(controller.eligible.value).toBe(true);
    expect(controller.records.value[0]).toEqual(previousRecord);
  });
});
