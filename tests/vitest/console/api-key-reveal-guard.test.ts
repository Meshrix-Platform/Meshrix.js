// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import ApiKeyDistributionView from "../../../apps/console/views/admin/ApiKeyDistributionView.vue";
import { setConsoleLocaleState } from "../../../apps/console/i18n/console";
import type { ApiKeyPolicy, ApiKeyRecord } from "../../../apps/console/lib/api-key-distribution-client";

const ONE_TIME_SENTINEL = "opaque-one-time-credential";
const ROTATED_SENTINEL = "opaque-rotated-credential";

// The view composes its controller directly; the mock installs a per-test fake
// through this holder so every test drives fresh ephemeral state.
const controllerHolder = vi.hoisted((): { factory: (() => any) | null } => ({ factory: null }));

vi.mock("../../../apps/console/composables/console-api-key-distribution-controller", () => ({
  useConsoleApiKeyDistributionController: () => {
    if (!controllerHolder.factory) throw new Error("test controller factory not installed");
    return controllerHolder.factory();
  },
}));

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

function createFakeController() {
  const oneTimeSecret = ref("");
  const revealedRecord = ref<ApiKeyRecord | null>(null);
  const copied = ref(false);
  const status = ref("");
  const dismissSecret = vi.fn((announce = false) => {
    const hadSecret = Boolean(oneTimeSecret.value);
    oneTimeSecret.value = "";
    revealedRecord.value = null;
    copied.value = false;
    if (announce && hadSecret) status.value = "dismissed";
  });
  return {
    applyProfile: vi.fn(),
    busy: ref(false),
    copied,
    copySecret: vi.fn(async () => { copied.value = true; }),
    create: vi.fn(async () => {
      revealedRecord.value = record();
      oneTimeSecret.value = ONE_TIME_SENTINEL;
    }),
    creating: ref(false),
    dataClassificationOptions: ref([]),
    dismissSecret,
    draft: ref({
      workloadDisplayName: "", organizationNodeId: "", expiresAt: "",
      selectedToolsetIds: [] as string[], allowedTools: [] as string[], selectedProfileId: "",
      maximumRisk: "low", serverAudience: "", selectedTargetIds: [] as string[],
      resourcesUnrestricted: true, selectedDataClassifications: [] as string[], workspaceIds: "",
      requestsPerMinute: null as number | null, maxConcurrentEffects: null as number | null,
    }),
    draftConfigDocument: ref("{}"),
    draftMissingHints: ref([] as string[]),
    draftValid: ref(true),
    eligible: ref(true),
    error: ref(""),
    importDraftConfig: vi.fn(),
    inferredSummaryItems: ref([]),
    loading: ref(false),
    maximumRiskOptions: ref([{ value: "low", label: "Low" }]),
    mutatingKeyId: ref(""),
    nodes: ref([{ nodeId: "organization-a", name: "Organization A", breadcrumb: [], nodeType: "organization" }]),
    oneTimeSecret,
    profileOptions: ref([]),
    records: ref([record()]),
    refresh: vi.fn(async () => true),
    revealedRecord,
    revoke: vi.fn(),
    // Direct true -> true swap (no dismiss in between) pins the view-level
    // acknowledgement reset regardless of controller sequencing.
    rotate: vi.fn(async (entry: ApiKeyRecord) => {
      revealedRecord.value = entry;
      oneTimeSecret.value = ROTATED_SENTINEL;
    }),
    scopes: ref({ organizationRevision: 1, authorizationRevision: 2 }),
    status,
    targetOptions: ref([]),
    toolsetOptions: ref([]),
  };
}

type FakeController = ReturnType<typeof createFakeController>;

async function mountConsoleView(): Promise<{
  controller: FakeController;
  router: Router;
  wrapper: VueWrapper;
}> {
  const controller = createFakeController();
  controllerHolder.factory = () => controller;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: ApiKeyDistributionView },
      { path: "/next", component: defineComponent({ template: '<div data-testid="next-page">next</div>' }) },
    ],
  });
  const wrapper = mount(defineComponent({ template: "<router-view />" }), {
    global: { plugins: [router] },
    attachTo: document.body,
  });
  await router.push("/");
  await flushPromises();
  return { controller, router, wrapper };
}

async function revealViaCreate(wrapper: VueWrapper): Promise<void> {
  await wrapper.find(".api-key-create-actions .primary-action").trigger("click");
  await flushPromises();
}

async function acknowledge(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-testid="api-key-reveal-confirm"] input').setValue(true);
  await flushPromises();
}

beforeEach(() => {
  setConsoleLocaleState("en");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("API key one-time reveal guard", () => {
  it("makes copy the primary, initially focused action and confirms copies inline", async () => {
    const { controller, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);

    const reveal = wrapper.find(".api-key-reveal");
    expect(reveal.exists()).toBe(true);
    expect(wrapper.find("[data-one-time-secret]").text()).toBe(ONE_TIME_SENTINEL);

    const actions = wrapper.find(".api-key-reveal-actions").findAll("button");
    const copy = actions[0];
    expect(copy.attributes("data-testid")).toBe("api-key-reveal-copy");
    expect(copy.classes()).toContain("primary-action");
    expect(copy.text()).toBe("Copy Key");
    expect(document.activeElement).toBe(copy.element);

    await copy.trigger("click");
    await flushPromises();
    expect(controller.copySecret).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="api-key-reveal-copy"]').text()).toBe("Copied");
  });

  it("disables dismissal until the explicit storage acknowledgement", async () => {
    const { controller, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);

    const dismiss = wrapper.find('[data-testid="api-key-reveal-dismiss"]');
    expect(dismiss.attributes("disabled")).toBeDefined();
    // Even a dispatched click must not dismiss while unacknowledged.
    await dismiss.trigger("click");
    expect(controller.dismissSecret).not.toHaveBeenCalled();
    expect(wrapper.find(".api-key-reveal").exists()).toBe(true);

    await acknowledge(wrapper);
    const enabledDismiss = wrapper.find('[data-testid="api-key-reveal-dismiss"]');
    expect(enabledDismiss.attributes("disabled")).toBeUndefined();
    await enabledDismiss.trigger("click");
    await flushPromises();
    expect(controller.dismissSecret).toHaveBeenCalledWith(true);
    expect(controller.oneTimeSecret.value).toBe("");
    expect(wrapper.find(".api-key-reveal").exists()).toBe(false);
  });

  it("blocks route changes while the reveal is open and unacknowledged", async () => {
    const { router, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);
    expect(wrapper.find('[data-testid="api-key-reveal-navigation-reminder"]').exists()).toBe(false);

    await router.push("/next");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/");
    const reminder = wrapper.find('[data-testid="api-key-reveal-navigation-reminder"]');
    expect(reminder.exists()).toBe(true);
    expect(reminder.text()).toContain("The plaintext key is still on screen");
    expect(wrapper.find(".api-key-reveal").exists()).toBe(true);
  });

  it("releases the guard after acknowledgement and clears the plaintext on leave", async () => {
    const { controller, router, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);

    await router.push("/next");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/");

    await acknowledge(wrapper);
    expect(wrapper.find('[data-testid="api-key-reveal-navigation-reminder"]').exists()).toBe(false);

    await router.push("/next");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/next");
    expect(wrapper.find('[data-testid="next-page"]').exists()).toBe(true);
    // Unmount on the route change clears the ephemeral plaintext.
    expect(controller.oneTimeSecret.value).toBe("");
    expect(document.body.innerHTML).not.toContain(ONE_TIME_SENTINEL);
  });

  it("releases the guard after acknowledge and dismiss", async () => {
    const { router, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);
    await acknowledge(wrapper);
    await wrapper.find('[data-testid="api-key-reveal-dismiss"]').trigger("click");
    await flushPromises();
    expect(wrapper.find(".api-key-reveal").exists()).toBe(false);

    await router.push("/next");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/next");
  });

  it("discard without storing clears the secret and releases the guard", async () => {
    const { controller, router, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);
    expect(wrapper.find(".api-key-reveal").text()).toContain(
      "Discarding clears the plaintext immediately; it can never be shown again.",
    );

    const discard = wrapper.find('[data-testid="api-key-reveal-discard"]');
    expect(discard.text()).toBe("Discard without storing");
    await discard.trigger("click");
    await flushPromises();
    expect(controller.dismissSecret).toHaveBeenCalled();
    expect(controller.oneTimeSecret.value).toBe("");
    expect(controller.status.value).toBe("The plaintext key was discarded; it cannot be viewed again.");
    expect(wrapper.find(".api-key-reveal").exists()).toBe(false);

    await router.push("/next");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/next");
  });

  it("resets the acknowledgement when a new secret replaces the reveal", async () => {
    const { controller, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);
    await acknowledge(wrapper);
    expect(wrapper.find('[data-testid="api-key-reveal-dismiss"]').attributes("disabled")).toBeUndefined();

    await wrapper.findAll(".api-key-record-actions button")[0].trigger("click");
    await flushPromises();
    expect(controller.oneTimeSecret.value).toBe(ROTATED_SENTINEL);
    const confirmInput = wrapper.find('[data-testid="api-key-reveal-confirm"] input');
    expect((confirmInput.element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-testid="api-key-reveal-dismiss"]').attributes("disabled")).toBeDefined();
  });

  it("keeps the plaintext out of storage, route state, and the DOM after dismissal", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { router, wrapper } = await mountConsoleView();
    await revealViaCreate(wrapper);
    expect(wrapper.find("[data-one-time-secret]").text()).toBe(ONE_TIME_SENTINEL);

    await wrapper.find('[data-testid="api-key-reveal-copy"]').trigger("click");
    await acknowledge(wrapper);
    await wrapper.find('[data-testid="api-key-reveal-dismiss"]').trigger("click");
    await flushPromises();

    const storageWrites = setItem.mock.calls.map((call) => String(call[1])).join(" ");
    expect(storageWrites).not.toContain(ONE_TIME_SENTINEL);
    const dump = (storage: Storage): string =>
      Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!) ?? "").join(" ");
    expect(dump(window.localStorage)).not.toContain(ONE_TIME_SENTINEL);
    expect(dump(window.sessionStorage)).not.toContain(ONE_TIME_SENTINEL);
    expect(document.body.innerHTML).not.toContain(ONE_TIME_SENTINEL);
    expect(router.currentRoute.value.fullPath).not.toContain(ONE_TIME_SENTINEL);
    // Refresh and reload clearing holds via ephemeral refs and is pinned by the
    // sibling controller test (api-key-distribution-view.test.ts); no new code.
  });

  it("keeps the no-re-view statement accurate and offers no reveal-again path", async () => {
    const source = readFileSync(
      "apps/console/views/admin/ApiKeyDistributionView.vue",
      "utf8",
    );
    expect(source).toContain("不存在再次查看、导出、恢复或归档操作");
    expect(source).toContain("there is no reveal-again, export, restore, or archive action.");
    expect(source).toContain("onBeforeRouteLeave");
    expect(source).not.toMatch(/revealAgain|exportSecret|archiveSecret/i);

    const { wrapper } = await mountConsoleView();
    expect(wrapper.find(".api-key-list-card").text()).toContain(
      "there is no reveal-again, export, restore, or archive action.",
    );
  });
});
