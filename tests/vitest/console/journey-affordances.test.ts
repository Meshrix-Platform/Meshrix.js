// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter, createWebHashHistory } from "vue-router";
import {
  buildConnectorConfigSnippet,
  CONNECTOR_SNIPPET_SECRET_PLACEHOLDER,
  useConsoleApiKeyDistributionController,
} from "../../../apps/console/composables/console-api-key-distribution-controller";
import { provideOperationPermissionView } from "../../../apps/console/composables/operationPermissionViewContext";
import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import ApiKeyDistributionView from "../../../apps/console/views/admin/ApiKeyDistributionView.vue";
import OperationPermissionView from "../../../apps/console/views/admin/OperationPermissionView.vue";
import ToolGrantCreateCard from "../../../apps/console/components/admin/operation-permission/ToolGrantCreateCard.vue";
import ToolAuditCard from "../../../apps/console/views/admin/tools/ToolAuditCard.vue";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";

const publishClient: any = vi.hoisted(() : any => ({
  createUpstreamService: vi.fn(),
  replaceUpstreamService: vi.fn(),
  disableUpstreamService: vi.fn(),
  republishUpstreamService: vi.fn(),
  removeUpstreamService: vi.fn(),
  listPublishedServices: vi.fn(),
  getPublishedService: vi.fn(),
  waitForUpstreamServicePublication: vi.fn(),
  checkUpstreamServiceRuntimeHealth: vi.fn(),
}));
const pageRefreshHandler: any = vi.hoisted(() : any => vi.fn());
const shellContextMock: any = vi.hoisted(() : any => ({ current: null }));

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...publishClient,
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));
vi.mock("#meshrix/console/server-console-shell-context", async () : Promise<any> => {
  const { namespaceServerConsoleShell } = await import("../../../tests/vitest/console/console-shell-test-utils");
  return {
    useServerConsoleShellContext: () : any => namespaceServerConsoleShell(shellContextMock.current),
  };
});
vi.mock("../../../apps/console/lib/authorization-governance-client", () : any => ({
  getAuthorizationGovernance: vi.fn(async () : Promise<any> => ({
    roles: [], departments: [], teams: [], userPolicies: [], agentBindings: [], agentGroups: [], approvals: [],
  })),
  upsertAuthorizationGovernance: vi.fn(),
}));

const apiKeyClientMocks: any = vi.hoisted(() : any => ({}));

vi.mock("../../../apps/console/lib/api-key-distribution-client", () : any => ({
  getApiKeyIssuerScopes: () : any => apiKeyClientMocks.current?.getIssuerScopes?.() || Promise.resolve(null),
  listApiKeys: () : any => apiKeyClientMocks.current?.list?.() || Promise.resolve({ records: [], nextCursor: null }),
  createApiKey: () : any => apiKeyClientMocks.current?.create?.() || Promise.resolve(null),
  rotateApiKey: () : any => apiKeyClientMocks.current?.rotate?.() || Promise.resolve(null),
  revokeApiKey: () : any => apiKeyClientMocks.current?.revoke?.() || Promise.resolve(null),
}));
vi.mock("../../../apps/console/lib/operation-permission-client", () : any => ({
  getOperationPermissionCatalog: () : any => apiKeyClientMocks.current?.getCatalog?.() || Promise.resolve(null),
}));

const journeyMessages: any = () : any => consoleMessages[currentConsoleLocale.value].journey;

function publication(revision: number) : any {
  return {
    publicationRef: `urn:meshrix:upstream-publication:${revision}`,
    status: "server_published" as const,
    candidateRevision: revision,
    candidateDigest: "a".repeat(64),
  };
}

function apiKeyScopes() : any {
  return {
    organizationRevision: 1, authorizationRevision: 2, catalogFingerprint: "catalog-a", serverAudience: "server-a",
    eligibleRoots: [{ nodeId: "organization-a", name: "Organization A", breadcrumb: ["Group", "Organization A"], nodeType: "organization" }],
    eligibleNodes: [{ nodeId: "organization-a", name: "Organization A", breadcrumb: ["Group", "Organization A"], nodeType: "organization" }],
  };
}

function apiKeyCatalog() : any {
  return {
    schemaVersion: "1",
    generatedAt: "2026-08-01T00:00:00.000Z",
    fingerprint: "catalog-a",
    scopes: [{ id: "scope-a", label: "Scope A", description: "" }],
    toolsets: [{ id: "toolset-a", label: "Toolset A", requiredScopes: ["scope-a"], maxRisk: "read_only" }],
    profiles: [],
    tools: [{
      id: "tool.read", version: "1", label: "Read Tool", description: "", owner: "core", source: "core",
      operationId: "op.read", handlerId: "h", toolsets: ["toolset-a"], requiredScopes: ["scope-a"],
      risk: "read_only", readOnly: true, destructive: false,
      concurrency: { workloadClass: "light", maxParallel: 64, cost: 1 }, requiresApproval: false,
      approvalScope: "", timeoutMs: 1, maxResultBytes: 1, status: "active", tags: [],
      serviceId: "service-a", capabilityId: "capability-a",
    }],
  };
}

function apiKeyRecord(overrides: Record<string, unknown> = {}) : any {
  return {
    keyId: "key-public-id", displayPrefix: "mxak1.pub…", credentialFingerprint: "fingerprint-a",
    workloadPrincipalId: "workload-principal-a", workloadDisplayName: "Build worker",
    organizationNodeId: "organization-a", organizationBreadcrumb: ["Group", "Organization A"],
    policy: {
      protocol: "mcp", serviceIds: ["service-a"], capabilityIds: ["capability-a"], toolsetIds: ["toolset-a"],
      allowedTools: ["tool.read"], deniedTools: [], scopeIds: ["scope-a"], maximumRisk: "low",
      audience: { serverAudience: "server-a", targetIds: ["codex"], connectorPackageIds: [] },
      resources: { mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [],
        semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [], effectKinds: [],
        secretBindingIds: [], allowedOrigins: [], allowedCidrs: [] },
      processIdentity: { mode: "optional" },
      limits: { maxUses: 10, requestsPerWindow: 3, windowSeconds: 60, maxConcurrentEffects: 1 },
      catalogFingerprint: "catalog-a",
    },
    policyFingerprint: "policy-a", status: "active", lifecycleRevision: 1, useCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z", rotatedAt: null, revokedAt: null,
    expiresAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function apiKeyClient(overrides: Record<string, unknown> = {}) : any {
  const client: any = {
    getIssuerScopes: vi.fn(async () : Promise<any> => apiKeyScopes()),
    list: vi.fn(async () : Promise<any> => ({ records: [], nextCursor: null })),
    create: vi.fn(async () : Promise<any> => ({ record: apiKeyRecord(), apiKey: "opaque-one-time-credential" })),
    rotate: vi.fn(async () : Promise<any> => ({ record: apiKeyRecord(), apiKey: "opaque-one-time-credential" })),
    revoke: vi.fn(async () : Promise<any> => apiKeyRecord({ status: "revoked" })),
    getCatalog: vi.fn(async () : Promise<any> => apiKeyCatalog()),
  };
  apiKeyClientMocks.current = client;
  return { ...client, ...overrides };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  pageRefreshHandler.mockClear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  publishClient.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
  publishClient.createUpstreamService.mockResolvedValue({
    ok: true, serviceId: "svc_fixture", state: "server_published", serviceRevision: 1, setRevision: 1,
    manifestDigest: "a".repeat(64), receiptRef: "urn:meshrix:receipt:fixture",
    publication: publication(1), replayed: false,
  });
  publishClient.waitForUpstreamServicePublication.mockResolvedValue({
    ok: true, setRevision: 1,
    service: {
      serviceId: "svc_fixture", state: "server_published", serviceRevision: 1,
      manifestDigest: "a".repeat(64), publication: publication(1),
    },
  });
  publishClient.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: true, status: "healthy" });
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = "";
  unregisterConsoleConfirmHost();
});

describe("publish success forward links", () : any => {
  it("renders grant-tool-access and view-in-gateway links with the serviceId query after completion", async () : Promise<any> => {
    const router: any = createRouter({
      history: createWebHashHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();
    const wrapper: any = mount(UpstreamServicePublishView, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();

    // Not present before the publish completes.
    expect(wrapper.find('[data-testid="publish-success-links"]').exists()).toBe(false);

    await wrapper.find("#upstream-service-key").setValue("inventory");
    await wrapper.find("#upstream-service-protocol").setValue("http");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();
    await flushPromises();

    const links: any[] = wrapper.findAll('[data-testid="publish-success-links"] a');
    expect(links).toHaveLength(2);
    expect(links[0].attributes("href")).toBe("#/admin/operation-permission");
    expect(links[0].text()).toBe(journeyMessages().grantToolAccess);
    expect(links[1].attributes("href")).toBe("#/admin/upstream-services?serviceId=svc_fixture");
    expect(links[1].text()).toBe(journeyMessages().viewInGateway);
    wrapper.unmount();
  });
});

describe("grant success link placement", () : any => {
  it("places the issue-client-key link on the persistent token panel success surface", async () : Promise<any> => {
    const issuedToolToken = ref("");
    const Host: any = defineComponent({
      components: { ToolGrantCreateCard },
      setup() : any {
        provideOperationPermissionView({
          isBusy: () : boolean => false,
          copyIssuedToolToken: vi.fn(),
          createGrant: vi.fn(),
          issuedToolToken,
          newGrantLabel: ref(""),
          newGrantScopes: ref([]),
          newGrantToolsets: ref([]),
          toggleNewGrantToolset: vi.fn(),
          operationPermissionToolsets: ref([]),
          toolScopes: ref([]),
        } as any);
        return {};
      },
      template: "<ToolGrantCreateCard />",
    });
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();
    const wrapper: any = mount(Host, { global: { plugins: [router] } });

    // No success surface yet — no link.
    expect(wrapper.find('[data-testid="grant-success-client-key-link"]').exists()).toBe(false);

    issuedToolToken.value = "one-time-token-value";
    await nextTick();
    const link: any = wrapper.find('[data-testid="grant-success-client-key-link"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("/admin/api-key-distribution");
    expect(link.text()).toBe(journeyMessages().issueClientKey);
    wrapper.unmount();
  });
});

describe("credentialing disambiguation lines", () : any => {
  it("carries the tool-token decision line and the client-key cross-link on operation permission", async () : Promise<any> => {
    shellContextMock.current = {
      operationPermissionConsole: {
        isBusy: () : boolean => false,
        copyIssuedToolToken: vi.fn(),
        createGrant: vi.fn(),
        deleteGrant: vi.fn(),
        enabledToolGrantCount: ref(0),
        grantHasToolset: vi.fn(() : boolean => false),
        grantToolRuleState: ref({}),
        issuedToolToken: ref(""),
        newGrantLabel: ref(""),
        newGrantScopes: ref([]),
        newGrantToolsets: ref([]),
        policyPreviewGrantId: ref(""),
        policyPreviewProfileId: ref(""),
        policyPreviewProfileOptionBarOptions: ref([]),
        policyPreviewResult: ref(null),
        policyPreviewToolId: ref(""),
        policyPreviewToolOptionBarOptions: ref([]),
        previewToolPolicy: vi.fn(),
        rotateGrant: vi.fn(),
        selectToolForManagement: vi.fn(),
        selectedOperationPermissionTool: ref(null),
        setGrantToolRule: vi.fn(),
        toggleGrantToolset: vi.fn(),
        toggleNewGrantToolset: vi.fn(),
        toolGrants: ref([]),
        operationPermissionTools: ref([]),
        operationPermissionToolsets: ref([]),
        toolScopes: ref([]),
        updateGrant: vi.fn(),
      },
    };
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();
    const wrapper: any = mount(OperationPermissionView, {
      global: {
        plugins: [router],
        stubs: {
          ToolGrantCreateCard: true,
          ToolGrantListCard: true,
          GrantToolRulePanel: true,
          AuthorizationGovernanceCard: true,
          ToolPolicyPreviewPanel: true,
        },
      },
    });
    await flushPromises();

    const line: any = wrapper.find('[data-testid="journey-disambiguation"]');
    expect(line.text()).toContain(journeyMessages().toolTokenDecision);
    const link: any = line.find("a.journey-cross-link");
    expect(link.attributes("href")).toBe("/admin/api-key-distribution");
    expect(link.text()).toBe(journeyMessages().clientKeyLink);
    wrapper.unmount();
  });

  it("carries the client-key decision line and the tool-token cross-link on key distribution", async () : Promise<any> => {
    const client: any = apiKeyClient();
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();
    const wrapper: any = mount(ApiKeyDistributionView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const line: any = wrapper.find('[data-testid="journey-disambiguation"]');
    expect(line.text()).toContain(journeyMessages().clientKeyDecision);
    const link: any = line.find("a.journey-cross-link");
    expect(link.attributes("href")).toBe("/admin/operation-permission");
    expect(link.text()).toBe(journeyMessages().toolTokenLink);
    wrapper.unmount();
  });
});

describe("connector configuration snippet", () : any => {
  it("builds a non-empty snippet per frozen target with key identity and the secret placeholder only", () : any => {
    const targets: string[] = ["openclaw", "codex", "claude-code", "antigravity", "opencode", "pi", "kimi"];
    const keyMaterial: any = { keyId: "key-public-id", displayPrefix: "mxak1.pub…" };
    for (const target of targets) {
      const snippet: string = buildConnectorConfigSnippet(target, keyMaterial);
      expect(snippet.length).toBeGreaterThan(0);
      expect(snippet).toContain(target);
      expect(snippet).toContain(keyMaterial.keyId);
      expect(snippet).toContain(keyMaterial.displayPrefix);
      expect(snippet).toContain(CONNECTOR_SNIPPET_SECRET_PLACEHOLDER);
      // The one-time secret is never embedded: only the placeholder marker
      // may reference it, and the builder receives no secret at all.
      expect(snippet).not.toContain("opaque-one-time-credential");
      expect(snippet).not.toMatch(/sk-[a-z0-9]+/i);
      // The JSON block is copy-paste-runnable.
      const jsonStart: number = snippet.indexOf("{");
      const jsonEnd: number = snippet.lastIndexOf("}");
      expect(() : any => JSON.parse(snippet.slice(jsonStart, jsonEnd + 1))).not.toThrow();
    }
  });

  it("returns empty guidance for unknown targets", () : any => {
    expect(buildConnectorConfigSnippet("unknown-client", { keyId: "k", displayPrefix: "p" })).toBe("");
  });

  it("scopes the revealed snippet to the first chosen target and copies without acknowledging storage", async () : Promise<any> => {
    const client: any = apiKeyClient();
    const copyText: any = vi.fn(async () : Promise<boolean> => true);
    const controller: any = useConsoleApiKeyDistributionController({
      client, confirmAction: vi.fn(async () : Promise<boolean> => true), copyText,
    });
    await controller.refresh();
    Object.assign(controller.draft.value, {
      workloadDisplayName: "Build worker", organizationNodeId: "organization-a", expiresAt: "2026-09-01T08:00",
      selectedToolsetIds: ["toolset-a"], selectedTargetIds: ["codex"],
    });
    await controller.create();

    expect(controller.connectorSnippet.value).toContain("codex");
    expect(controller.connectorSnippet.value).toContain("key-public-id");
    expect(controller.connectorSnippet.value).toContain("mxak1.pub");
    expect(controller.connectorSnippet.value).toContain(CONNECTOR_SNIPPET_SECRET_PLACEHOLDER);
    expect(controller.connectorSnippet.value).not.toContain("opaque-one-time-credential");

    await controller.copyConnectorSnippet();
    expect(controller.snippetCopied.value).toBe(true);
    expect(copyText).toHaveBeenCalledWith(controller.connectorSnippet.value);
    // Copying the snippet is a separate affordance — nothing about the
    // reveal acknowledgement changed (that state is view-side, checkbox-only).
    expect(controller.oneTimeSecret.value).toBe("opaque-one-time-credential");

    controller.dismissSecret(true);
    expect(controller.connectorSnippet.value).toBe("");
    expect(controller.snippetCopied.value).toBe(false);
  });
});

describe("key-reveal step snippet rendering", () : any => {
  it("renders the snippet under the reveal with a copy button and keeps the acknowledgement flow intact", async () : Promise<any> => {
    apiKeyClient();
    registerConsoleConfirmHost();
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();
    const wrapper: any = mount(ApiKeyDistributionView, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();

    // Step 1: choose the Agent and identify the connection.
    const checkboxByLabel = async (label: string) : Promise<any> => {
      const button: any = wrapper.findAll("button[role=checkbox]").find((candidate?: any) : any => candidate.text().includes(label));
      expect(button).toBeDefined();
      await button.trigger("click");
    };
    await wrapper.find('[data-testid="agent-target-select"]').setValue("codex");
    await wrapper.findAll(".api-key-form-grid input")[0].setValue("Build worker");
    await wrapper.findAll(".api-key-form-grid select")[1].setValue("organization-a");
    await wrapper.findAll(".api-key-form-grid input")[1].setValue("2026-09-01T08:00");
    await wrapper.find('[data-testid="agent-setup-agent-step"] .primary-action').trigger("click");
    expect(wrapper.find('[data-testid="agent-setup-access-step"]').attributes("style") || "").not.toContain("display: none");

    // Step 2: choose access, then review the bounded connection.
    await checkboxByLabel("Toolset A");
    await wrapper.find('[data-testid="agent-setup-access-step"] .primary-action').trigger("click");
    expect(wrapper.find('[data-testid="agent-setup-review-step"]').attributes("style") || "").not.toContain("display: none");
    expect(wrapper.find(".api-key-trust-summary").text()).toContain("Operation Permission");

    const createButton: any = wrapper.findAll("button.primary-action").find((candidate?: any) : any => candidate.text().includes("生成连接资料"));
    await createButton.trigger("click");
    await flushPromises();
    settleConsoleConfirm(true);
    await flushPromises();

    // Reveal rendered with the snippet section under it.
    expect(wrapper.find('[data-testid="api-key-reveal-confirm"]').exists()).toBe(true);
    const snippet: any = wrapper.find('[data-testid="api-key-connector-snippet"]');
    expect(snippet.exists()).toBe(true);
    expect(snippet.find("pre").text()).toContain("codex");
    expect(snippet.find("pre").text()).toContain("key-public-id");
    expect(snippet.find("pre").text()).toContain(CONNECTOR_SNIPPET_SECRET_PLACEHOLDER);
    expect(snippet.find("pre").text()).not.toContain("opaque-one-time-credential");

    // Copying the snippet does NOT satisfy the storage acknowledgement.
    const acknowledgement: any = wrapper.find('[data-testid="api-key-reveal-confirm"] input');
    expect((acknowledgement.element as HTMLInputElement).checked).toBe(false);
    await snippet.find('[data-testid="api-key-connector-snippet-copy"]').trigger("click");
    await flushPromises();
    expect((acknowledgement.element as HTMLInputElement).checked).toBe(false);
    wrapper.unmount();
  });
});

describe("first-call indicator on the tool audit card", () : any => {
  it("renders the connector CTA on the empty state and the done indicator once a call is recorded", async () : Promise<any> => {
    const router: any = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/", component: { render: () : any => null } }],
    });
    await router.push("/");
    await router.isReady();

    const empty: any = mount(ToolAuditCard, { props: { items: [] }, global: { plugins: [router] } });
    expect(empty.find('[data-testid="first-call-indicator"]').exists()).toBe(false);
    const cta: any = empty.find('[data-testid="first-call-cta"]');
    expect(cta.exists()).toBe(true);
    expect(cta.attributes("href")).toBe("/admin/api-key-distribution");
    expect(cta.text()).toBe(journeyMessages().firstCallCta);
    empty.unmount();

    const recorded: any = mount(ToolAuditCard, {
      props: {
        items: [{
          toolExecutionId: "exec-a", traceId: "trace-a", toolId: "tool.read", toolVersion: "1",
          toolsetIds: ["toolset-a"], subjectType: "agent", subjectId: "agent-a", grantId: "grant-a",
          agentId: "agent-a", profileId: "profile-a", operationId: "op.read", risk: "read_only",
          decision: "allow", status: "ok", errorCode: "", durationMs: 8,
          startedAt: "2026-06-04T09:00:00.000Z", finishedAt: "2026-06-04T09:00:00.008Z",
          policyDecisionId: "pd-a",
        }],
      },
      global: { plugins: [router] },
    });
    expect(recorded.find('[data-testid="first-call-cta"]').exists()).toBe(false);
    expect(recorded.find('[data-testid="first-call-indicator"]').text()).toBe(journeyMessages().firstCallRecorded);
    recorded.unmount();
  });
});

describe("frontend feature registry coverage", () : any => {
  it("parses and covers the new journey actions under their owning routes", () : any => {
    const yaml: string = readFileSync(
      "packages/foundation/config/frontend-feature-registry.yaml",
      "utf8",
    );
    const routePaths: string[] = [...yaml.matchAll(/^\s+- routePath: (.+)$/gm)].map((match) : string => match[1]);
    const actions: string[] = [...yaml.matchAll(/^\s+- ([a-z0-9][a-z0-9.-]*)$/gm)].map((match) : string => match[1]);

    expect(routePaths).toContain("/admin/publish-upstream-service");
    expect(routePaths).toContain("/admin/api-key-distribution");
    for (const action of [
      "upstream.publish.grant-link",
      "upstream.publish.gateway-link",
      "admin.operation-permission.client-key-link",
      "admin.operation-permission.client-key-crosslink",
      "apikey.connector-snippet.copy",
      "apikey.tool-token.crosslink",
      "admin.tools.audit.first-call",
    ]) {
      expect(actions).toContain(action);
    }
  });
});
