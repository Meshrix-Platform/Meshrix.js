// @vitest-environment jsdom
import { randomBytes } from "node:crypto";
import { defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const bridge: any = vi.hoisted((): any => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

const confirmMock: any = vi.hoisted((): any => vi.fn(async (): Promise<boolean> => true));

const newEnrollmentToken = (): string => `met_${randomBytes(12).toString("hex")}`;

vi.mock("@meshrix/ui-console/bridge-http", (): any => bridge);
vi.mock(
  "../../../apps/console/composables/console-browser-effects",
  async (importOriginal: any): Promise<any> => ({
    ...(await importOriginal()),
    confirmConsoleAction: confirmMock,
  }),
);

import ManagedEndpointsView from "../../../apps/console/views/admin/ManagedEndpointsView.vue";
import { useManagedEndpointsViewController } from "../../../apps/console/composables/console-managed-endpoints-view-controller";
import { provideServerConsoleShell } from "../../../apps/console/composables/server-console-shell-context";
import { ADMIN_ROUTE_REGISTRY } from "../../../apps/console/router/admin-route-registry";
import { consoleMessages } from "../../../apps/console/i18n/console";

function deferred<T>(): any {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise: any = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const fullScopes = [
  "endpoints:read",
  "endpoints:manage",
  "endpoints:execute",
  "endpoints:approve",
];

function makeAccess(overrides: Record<string, any> = {}): any {
  return {
    authenticated: ref(true),
    subject: ref({ subjectId: "owner-1" }),
    scopes: ref([...fullScopes]),
    featureIds: ref(["work-queue-core"]),
    ...overrides,
  };
}

const endpointFixture: any = {
  endpointId: "me_shared1",
  tenantId: "t1",
  organizationId: "o1",
  label: "Fixture device",
  kind: "shared",
  state: "active",
  generation: 1,
  allowedCapabilityIds: ["fixture.echo", "ghost.cap"],
  publishedCapabilities: [
    {
      capabilityId: "fixture.echo",
      label: "Fixture echo",
      kind: "command",
      revision: 1,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ],
};

function makeTask(overrides: Record<string, any> = {}): any {
  return {
    taskId: "mt_1",
    requestId: "mreq_1",
    tenantId: "t1",
    organizationId: "o1",
    endpointId: endpointFixture.endpointId,
    capabilityId: "fixture.echo",
    capabilityRevision: 1,
    input: {},
    requester: { subjectId: "owner-1" },
    workItemId: "wi_1",
    state: "pending",
    cancelRequested: false,
    progress: null,
    result: null,
    errorCode: "",
    createdAtMs: 1,
    updatedAtMs: 1,
    terminalAtMs: 0,
    ...overrides,
  };
}

function inventory(overrides: Record<string, any> = {}): any {
  return {
    endpoints: [endpointFixture],
    tasks: [],
    observations: [{ endpointId: endpointFixture.endpointId, lastContactAtMs: null }],
    pendingPermissions: [],
    ...overrides,
  };
}

const mountedWrappers: any[] = [];

function mountView(access: any = makeAccess()): any {
  const Wrapper: any = defineComponent({
    setup(): any {
      provideServerConsoleShell({
        access: {
          isAuthenticated: access.authenticated,
          currentUser: access.subject,
          currentUserScopes: access.scopes,
        },
        runtime: { activeConsoleFeatureIds: access.featureIds },
      });
      return (): any => h(ManagedEndpointsView);
    },
  });
  const wrapper: any = mount(Wrapper);
  mountedWrappers.push(wrapper);
  return wrapper;
}

function mountController(access: any = makeAccess()): any {
  let controller: any = null;
  const Probe: any = defineComponent({
    setup(): any {
      controller = useManagedEndpointsViewController({ access });
      return (): any => h("div");
    },
  });
  const wrapper: any = mount(Probe);
  mountedWrappers.push(wrapper);
  return { controller, wrapper };
}

afterEach((): any => {
  while (mountedWrappers.length) mountedWrappers.pop().unmount();
});

beforeEach((): any => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  bridge.getJson.mockResolvedValue(inventory());
  bridge.postJson.mockResolvedValue({});
});

describe("ManagedEndpointsView", (): any => {
  it("registers the route and locale keys in both languages", (): any => {
    const entry: any = ADMIN_ROUTE_REGISTRY.find(
      (item: any): any => item.viewKey === "managedEndpoints",
    );
    expect(entry).toMatchObject({
      slug: "managed-endpoints",
      componentName: "ManagedEndpointsView.vue",
      requiredScopes: ["endpoints:read"],
      requiredFeatureIds: ["work-queue-core"],
      section: "operations",
    });
    for (const locale of ["zh-CN", "en"]) {
      expect(consoleMessages[locale].nav.managedEndpoints).toBeTruthy();
      expect(consoleMessages[locale].managedEndpoints.title).toBeTruthy();
    }
  });

  it("renders empty state and hides mutation controls for read-only scope", async (): Promise<any> => {
    bridge.getJson.mockResolvedValue(inventory({ endpoints: [] }));
    const access: any = makeAccess({ scopes: ref(["endpoints:read"]) });
    const { controller } = mountController(access);
    const wrapper: any = mountView(access);
    await nextTick();
    await vi.waitFor((): any => expect(wrapper.text()).toContain("暂无托管设备"));
    expect(wrapper.find('[data-testid="managed-create-submit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="managed-policy-save"]').exists()).toBe(false);
    expect(controller.canManage.value).toBe(false);
    await controller.createEndpoint();
    await controller.submitTask();
    expect(bridge.postJson).not.toHaveBeenCalled();
  });

  it("creates a device and shows the enrollment token masked without storage writes", async (): Promise<any> => {
    const fixtureToken = newEnrollmentToken();
    bridge.postJson.mockResolvedValue({
      endpoint: { ...endpointFixture, state: "pending" },
      enrollmentToken: fixtureToken,
    });
    const wrapper: any = mountView();
    await vi.waitFor((): any =>
      expect(wrapper.find('[data-testid="managed-device-me_shared1"]').exists()).toBe(true),
    );
    await wrapper.find('[data-testid="managed-create-label"]').setValue("Bench");
    await wrapper.find('[data-testid="managed-create-kind"]').setValue("shared");
    await wrapper.find("form.managed-create-form").trigger("submit.prevent");
    await vi.waitFor((): any => expect(bridge.postJson).toHaveBeenCalledTimes(1));
    expect(bridge.postJson.mock.calls[0][0]).toBe("/api/endpoints");
    expect(bridge.postJson.mock.calls[0][1]).toEqual({
      label: "Bench",
      kind: "shared",
      allowedCapabilityIds: [],
    });
    const tokenInput: any = wrapper.find('[data-testid="managed-enrollment-token"]');
    expect(tokenInput.exists()).toBe(true);
    expect(tokenInput.attributes("type")).toBe("password");
    expect(tokenInput.element.value).not.toContain(fixtureToken);
    expect(JSON.stringify(window.localStorage)).not.toContain(fixtureToken);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(fixtureToken);
    const dismiss: any = wrapper
      .findAll("button")
      .find((button: any): any => button.attributes("data-testid") === undefined && ["关闭", "Dismiss"].includes(button.text()));
    expect(dismiss).toBeTruthy();
    await dismiss.trigger("click");
    expect(wrapper.find('[data-testid="managed-enrollment-token"]').exists()).toBe(false);
  });

  it("clears the token when scopes change and a late create response cannot restore it", async (): Promise<any> => {
    const pending: any = deferred<any>();
    bridge.postJson.mockImplementation((): any => pending.promise);
    const access: any = makeAccess();
    const { controller } = mountController(access);
    void controller.createEndpoint();
    await vi.waitFor((): any => expect(bridge.postJson).toHaveBeenCalledTimes(1));
    access.scopes.value = ["endpoints:read"];
    await nextTick();
    pending.resolve({
      endpoint: endpointFixture,
      enrollmentToken: newEnrollmentToken(),
    });
    await pending.promise;
    await nextTick();
    expect(controller.enrollmentToken.value).toBe("");
  });

  it("does not mutate state after unmount", async (): Promise<any> => {
    const pending: any = deferred<any>();
    bridge.getJson.mockImplementation((): any => pending.promise);
    const { controller, wrapper } = mountController();
    void controller.refresh();
    wrapper.unmount();
    pending.resolve(inventory());
    await pending.promise;
    await nextTick();
    expect(controller.inventory.value).toBeNull();
    expect(controller.taskDetail.value).toBeNull();
  });

  it("preserves unpublished allowed capability ids on policy save", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.allowedIds.value = ["fixture.echo"];
    controller.allowedIds.value = ["fixture.echo", "ghost.cap"];
    await controller.savePolicy();
    const saveCall: any = bridge.postJson.mock.calls.at(-1);
    expect(saveCall[0]).toBe(`/api/endpoints/${endpointFixture.endpointId}`);
    expect(saveCall[1].allowedCapabilityIds).toEqual(["fixture.echo", "ghost.cap"]);
  });

  it("submits a task with a stable requestId across response-loss retry and a new id on changed intent", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.capabilityId.value = "fixture.echo";
    controller.inputText.value = '{ "value": "fixture request" }';

    bridge.postJson.mockRejectedValueOnce(new Error("lost"));
    await controller.submitTask();
    const firstId: any = bridge.postJson.mock.calls[0][1].requestId;
    expect(firstId).toMatch(/^mreq_/u);
    expect(controller.error.value).toBe("actionFailed");

    bridge.postJson.mockRejectedValueOnce(new Error("lost again"));
    await controller.submitTask();
    expect(bridge.postJson.mock.calls[1][1].requestId).toBe(firstId);

    controller.inputText.value = '{ "value": "different" }';
    bridge.postJson.mockRejectedValueOnce(new Error("lost 3"));
    await controller.submitTask();
    expect(bridge.postJson.mock.calls[2][1].requestId).not.toBe(firstId);
    expect(bridge.postJson.mock.calls[2][2]).toEqual({ safetyConfirm: true });
  });

  it("rejects invalid JSON before any network call and never renders failure as success", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.inputText.value = "{ not json";
    await controller.submitTask();
    expect(bridge.postJson).not.toHaveBeenCalled();
    expect(controller.error.value).toBe("invalidJson");

    controller.inputText.value = "{}";
    bridge.postJson.mockRejectedValueOnce(new Error("boom"));
    await controller.submitTask();
    expect(controller.error.value).toBe("actionFailed");
    expect(controller.taskDetail.value).toBeNull();
  });

  it("keeps declined confirmations at zero mutation calls and confirmed ones set the safety header", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);

    confirmMock.mockResolvedValueOnce(false);
    await controller.revokeEndpoint();
    expect(bridge.postJson).not.toHaveBeenCalled();

    bridge.postJson.mockResolvedValueOnce({ endpoint: endpointFixture });
    await controller.revokeEndpoint();
    expect(bridge.postJson).toHaveBeenCalledWith(
      `/api/endpoints/${endpointFixture.endpointId}/revoke`,
      {},
      { safetyConfirm: true },
    );

    const detail: any = {
      task: makeTask({ state: "leased" }),
      workItem: null,
      pendingPermission: null,
    };
    bridge.getJson.mockResolvedValueOnce(detail);
    controller.selectTask("mt_1");
    await vi.waitFor((): any => expect(controller.taskDetail.value).not.toBeNull());

    confirmMock.mockResolvedValueOnce(false);
    await controller.cancelTask();
    expect(bridge.postJson).toHaveBeenCalledTimes(1);

    bridge.postJson.mockResolvedValueOnce({ task: makeTask({ state: "cancelled" }), idempotent: false });
    bridge.getJson.mockResolvedValueOnce(detail);
    await controller.cancelTask();
    expect(bridge.postJson).toHaveBeenLastCalledWith(
      "/api/endpoints/tasks/mt_1/cancel",
      {},
      { safetyConfirm: true },
    );
  });

  it("sends the exact opaque permission option id through the governed confirm", async (): Promise<any> => {
    const option: any = { optionId: " allow/once ", name: "Allow once", kind: "allow_once" };
    const detail: any = {
      task: makeTask({ state: "leased" }),
      workItem: null,
      pendingPermission: {
        permissionId: "mperm_fixture_approval",
        taskId: "mt_1",
        state: "pending",
        prompt: {
          sessionId: "fixture-session",
          toolCall: {
            toolCallId: "fixture-tool",
            title: "Fixture operation",
            name: null,
            kind: null,
            status: null,
            content: [],
            rawInput: null,
            locations: [],
          },
          options: [option],
        },
        selectedOptionId: null,
      },
    };
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    bridge.getJson.mockResolvedValueOnce(detail);
    controller.selectTask("mt_1");
    await vi.waitFor((): any => expect(controller.pendingPermission.value).not.toBeNull());

    await controller.resolvePermission(option);
    const call: any = bridge.postJson.mock.calls.at(-1);
    expect(call[0]).toBe("/api/endpoints/tasks/mt_1/permission");
    expect(call[1]).toEqual({
      taskId: "mt_1",
      permissionId: "mperm_fixture_approval",
      selectedOptionId: " allow/once ",
    });
    expect(call[2]).toEqual({ safetyConfirm: true });
  });

  it("keeps a stale task detail response from replacing a newer selection", async (): Promise<any> => {
    const stale: any = deferred<any>();
    const latest: any = deferred<any>();
    bridge.getJson
      .mockResolvedValueOnce(inventory())
      .mockImplementationOnce((): any => stale.promise)
      .mockResolvedValueOnce({ taskId: "mt_stale", after: 0, lastSeq: 0, events: [] })
      .mockImplementationOnce((): any => latest.promise)
      .mockResolvedValueOnce({ taskId: "mt_latest", after: 0, lastSeq: 0, events: [] });
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectTask("mt_stale");
    controller.selectTask("mt_latest");
    latest.resolve({ task: makeTask({ taskId: "mt_latest" }), workItem: null, pendingPermission: null });
    await vi.waitFor((): any => expect(controller.taskDetail.value?.task.taskId).toBe("mt_latest"));
    stale.resolve({ task: makeTask({ taskId: "mt_stale" }), workItem: null, pendingPermission: null });
    await stale.promise;
    await nextTick();
    expect(controller.taskDetail.value?.task.taskId).toBe("mt_latest");
  });

  it("keeps unknown, pending, failed and succeeded states visually distinct", async (): Promise<any> => {
    bridge.getJson.mockResolvedValue(
      inventory({
        tasks: [
          makeTask({ taskId: "t_u", state: "unknown" }),
          makeTask({ taskId: "t_p", state: "pending" }),
          makeTask({ taskId: "t_f", state: "failed" }),
          makeTask({ taskId: "t_s", state: "succeeded", result: { value: "ok" } }),
        ],
      }),
    );
    const wrapper: any = mountView();
    await vi.waitFor((): any =>
      expect(wrapper.find('[data-testid="managed-device-me_shared1"]').exists()).toBe(true),
    );
    await wrapper.find('[data-testid="managed-device-me_shared1"]').trigger("click");
    await nextTick();
    const text: any = wrapper.text();
    expect(text).toContain("状态待核对");
    expect(text).toContain("待处理");
    expect(text).toContain("失败");
    expect(text).toContain("成功");
  });

  it("clears secrets on logout", async (): Promise<any> => {
    const access: any = makeAccess();
    const { controller } = mountController(access);
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.enrollmentToken.value = newEnrollmentToken();
    access.authenticated.value = false;
    await nextTick();
    expect(controller.enrollmentToken.value).toBe("");
    expect(controller.inventory.value).toBeNull();
  });
});

describe("actor isolation and guarded actions", (): any => {
  it("lets a switched actor load while a stale list response cannot overwrite or unblock it", async (): Promise<any> => {
    const stale: any = deferred<any>();
    const fresh: any = deferred<any>();
    bridge.getJson
      .mockImplementationOnce((): any => stale.promise)
      .mockImplementationOnce((): any => fresh.promise);
    const access: any = makeAccess();
    const { controller } = mountController(access);
    await nextTick();
    access.subject.value = { subjectId: "actor-b" };
    await nextTick();
    await vi.waitFor((): any => expect(bridge.getJson).toHaveBeenCalledTimes(2));
    expect(controller.loading.value).toBe(true);
    stale.resolve(inventory());
    await stale.promise;
    await nextTick();
    expect(controller.loading.value).toBe(true);
    expect(controller.inventory.value).toBeNull();
    fresh.resolve(inventory({ endpoints: [] }));
    await vi.waitFor((): any => expect(controller.loading.value).toBe(false));
    await nextTick();
    expect(controller.endpoints.value.length).toBe(0);
    expect(controller.loading.value).toBe(false);
  });

  it("prevents an old create response from restoring the token or clearing a newer busy owner", async (): Promise<any> => {
    const createGate: any = deferred<any>();
    bridge.postJson.mockImplementation((): any => createGate.promise);
    const access: any = makeAccess();
    const { controller } = mountController(access);
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.createLabel.value = "Old device";
    void controller.createEndpoint();
    await vi.waitFor((): any => expect(controller.actionBusy.value).toBe("create"));
    access.subject.value = { subjectId: "actor-b" };
    await nextTick();
    expect(controller.actionBusy.value).toBe("");
    expect(controller.enrollmentToken.value).toBe("");
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    const saveGate: any = deferred<any>();
    bridge.postJson.mockImplementation((): any => saveGate.promise);
    void controller.savePolicy();
    await vi.waitFor((): any => expect(controller.actionBusy.value).toBe("save"));
    createGate.resolve({
      endpoint: endpointFixture,
      enrollmentToken: newEnrollmentToken(),
    });
    await nextTick();
    expect(controller.enrollmentToken.value).toBe("");
    expect(controller.actionBusy.value).toBe("save");
    saveGate.resolve({ endpoint: endpointFixture });
  });

  it.each(["revoke", "submit", "cancel", "resolve"] as const)(
    "drops a %s action when the actor changes during confirmation",
    async (kind: any): Promise<any> => {
      const access: any = makeAccess();
      const { controller } = mountController(access);
      await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
      controller.selectEndpoint(endpointFixture.endpointId);
      if (kind === "submit") {
        controller.capabilityId.value = "fixture.echo";
        controller.inputText.value = "{}";
      }
      if (kind === "cancel" || kind === "resolve") {
        bridge.getJson.mockResolvedValueOnce({
          task: makeTask({ state: "leased" }),
          workItem: null,
          pendingPermission: {
            permissionId: "mperm_1",
            taskId: "mt_1",
            state: "pending",
            prompt: {
              sessionId: "s",
              toolCall: { title: "Tool" },
              options: [{ optionId: " allow/once ", name: "Allow once", kind: "allow_once" }],
            },
            selectedOptionId: null,
          },
        });
        controller.selectTask("mt_1");
        await vi.waitFor((): any => expect(controller.taskDetail.value).not.toBeNull());
      }
      const confirmGate: any = deferred<any>();
      confirmMock.mockImplementation((): any => confirmGate.promise);
      const invoke: any = {
        revoke: (): any => controller.revokeEndpoint(),
        submit: (): any => controller.submitTask(),
        cancel: (): any => controller.cancelTask(),
        resolve: (): any =>
          controller.resolvePermission({ optionId: " allow/once ", name: "Allow once" }),
      }[kind];
      void invoke();
      await vi.waitFor((): any => expect(confirmMock).toHaveBeenCalled());
      access.subject.value = { subjectId: "actor-b" };
      await nextTick();
      confirmGate.resolve(true);
      await confirmGate.promise;
      await nextTick();
      expect(bridge.postJson).not.toHaveBeenCalled();
    },
  );

  it("runs only one dialog and one post for overlapping submissions", async (): Promise<any> => {
    const confirmGate: any = deferred<any>();
    confirmMock.mockImplementation((): any => confirmGate.promise);
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.capabilityId.value = "fixture.echo";
    controller.inputText.value = "{}";
    void controller.submitTask();
    await vi.waitFor((): any => expect(confirmMock).toHaveBeenCalledTimes(1));
    void controller.submitTask();
    await nextTick();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    bridge.postJson.mockResolvedValueOnce({ task: makeTask({}), idempotent: false });
    confirmGate.resolve(true);
    await vi.waitFor((): any => expect(bridge.postJson).toHaveBeenCalledTimes(1));
  });

  it("sends the payload captured before confirmation even if fields change meanwhile", async (): Promise<any> => {
    const confirmGate: any = deferred<any>();
    confirmMock.mockImplementation((): any => confirmGate.promise);
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.capabilityId.value = "fixture.echo";
    controller.inputText.value = '{ "value": "first" }';
    void controller.submitTask();
    await vi.waitFor((): any => expect(confirmMock).toHaveBeenCalled());
    controller.capabilityId.value = "ghost.cap";
    controller.inputText.value = '{ "value": "second" }';
    bridge.postJson.mockResolvedValueOnce({ task: makeTask({}), idempotent: false });
    confirmGate.resolve(true);
    await vi.waitFor((): any => expect(bridge.postJson).toHaveBeenCalledTimes(1));
    const call: any = bridge.postJson.mock.calls[0];
    expect(call[1].capabilityId).toBe("fixture.echo");
    expect(call[1].input).toEqual({ value: "first" });
  });

  it("invalidates a pending task detail when selection changes", async (): Promise<any> => {
    const detailGate: any = deferred<any>();
    bridge.getJson
      .mockResolvedValueOnce(inventory())
      .mockImplementationOnce((): any => detailGate.promise);
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.selectTask("mt_1");
    controller.selectEndpoint("me_other");
    detailGate.resolve({ task: makeTask({ taskId: "mt_1" }), workItem: null, pendingPermission: null });
    await detailGate.promise;
    await nextTick();
    expect(controller.taskDetail.value).toBeNull();

    const detailGateTwo: any = deferred<any>();
    bridge.getJson.mockImplementationOnce((): any => detailGateTwo.promise);
    controller.selectTask("mt_2");
    controller.selectTask("");
    detailGateTwo.resolve({
      task: makeTask({ taskId: "mt_2" }),
      workItem: null,
      pendingPermission: null,
    });
    await detailGateTwo.promise;
    await nextTick();
    expect(controller.taskDetail.value).toBeNull();
  });

  it("refreshes a task without listing inventory while patching its list row", async (): Promise<any> => {
    bridge.getJson.mockResolvedValue(
      inventory({ tasks: [makeTask({ taskId: "mt_1", state: "pending" })] }),
    );
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    bridge.getJson.mockResolvedValueOnce({
      task: makeTask({ taskId: "mt_1", state: "leased" }),
      workItem: null,
      pendingPermission: null,
    });
    controller.selectTask("mt_1");
    await vi.waitFor((): any => expect(controller.taskDetail.value).not.toBeNull());
    bridge.getJson.mockResolvedValueOnce({
      task: makeTask({ taskId: "mt_1", state: "succeeded", result: { value: "ok" } }),
      workItem: null,
      pendingPermission: null,
    });
    const callsBefore: any = bridge.getJson.mock.calls.length;
    await controller.refreshTaskDetail();
    expect(bridge.getJson).toHaveBeenCalledTimes(callsBefore + 1);
    expect(bridge.getJson.mock.calls.at(-1)[0]).toBe("/api/endpoints/tasks/mt_1");
    expect(controller.inventory.value.tasks[0].state).toBe("succeeded");
  });

  it("reuses the requestId for key-reordered identical input", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.capabilityId.value = "fixture.echo";
    controller.inputText.value = '{ "b": 1, "a": 2 }';
    bridge.postJson.mockRejectedValueOnce(new Error("lost"));
    await controller.submitTask();
    const firstId: any = bridge.postJson.mock.calls[0][1].requestId;
    controller.inputText.value = '{ "a": 2, "b": 1 }';
    bridge.postJson.mockRejectedValueOnce(new Error("lost"));
    await controller.submitTask();
    expect(bridge.postJson.mock.calls[1][1].requestId).toBe(firstId);
  });

  it("removes an unpublished draft id and saves the corrected list", async (): Promise<any> => {
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    expect(controller.unpublishedAllowed.value).toEqual(["ghost.cap"]);
    controller.removeAllowed("ghost.cap");
    expect(controller.unpublishedAllowed.value).toEqual([]);
    bridge.postJson.mockResolvedValueOnce({ endpoint: endpointFixture });
    await controller.savePolicy();
    const call: any = bridge.postJson.mock.calls.at(-1);
    expect(call[1].allowedCapabilityIds).toEqual(["fixture.echo"]);
  });

  it("refuses mutation entirely without scope or feature", async (): Promise<any> => {
    const access: any = makeAccess({
      scopes: ref([]),
      featureIds: ref([]),
    });
    const { controller } = mountController(access);
    await nextTick();
    expect(bridge.getJson).not.toHaveBeenCalled();
    await controller.createEndpoint();
    await controller.submitTask();
    expect(bridge.postJson).not.toHaveBeenCalled();
    expect(controller.error.value).toBe("scopeRequired");
  });

  it("replays the task event timeline, dedupes by seq and follows with a wait long-poll", async (): Promise<any> => {
    const workspaceEndpoint: any = {
      ...endpointFixture,
      publishedWorkspaces: [{ workspaceId: "ws.main", label: "Main workspace" }],
    };
    bridge.getJson.mockResolvedValue(inventory({ endpoints: [workspaceEndpoint] }));
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(workspaceEndpoint.endpointId);
    bridge.getJson
      .mockResolvedValueOnce({ task: makeTask({ taskId: "mt_1" }), workItem: null, pendingPermission: null })
      .mockResolvedValueOnce({
        taskId: "mt_1",
        after: 0,
        lastSeq: 2,
        events: [
          { seq: 1, kind: "command.start", at: "2024-01-01T00:00:00.000Z", payload: { n: 1 } },
          { seq: 2, kind: "agent.runtime", at: "2024-01-01T00:00:01.000Z", payload: { n: 2 } },
        ],
      });
    controller.selectTask("mt_1");
    await vi.waitFor((): any => expect(controller.taskEvents.value.length).toBe(2));
    expect(bridge.getJson.mock.calls.at(-1)[0]).toBe("/api/endpoints/tasks/mt_1/events?after=0");

    const followGate: any = deferred<any>();
    bridge.getJson.mockImplementationOnce((): any => followGate.promise);
    controller.toggleTaskEventFollow();
    await vi.waitFor((): any =>
      expect(bridge.getJson.mock.calls.at(-1)[0]).toBe("/api/endpoints/tasks/mt_1/events?after=2&wait=30"),
    );
    expect(controller.eventsFollowing.value).toBe(true);
    followGate.resolve({
      taskId: "mt_1",
      after: 2,
      lastSeq: 3,
      events: [
        { seq: 2, kind: "agent.runtime", at: "2024-01-01T00:00:02.000Z", payload: { n: 2 } },
        { seq: 3, kind: "command.end", at: "2024-01-01T00:00:03.000Z", payload: { n: 3 } },
      ],
    });
    await vi.waitFor((): any => expect(controller.taskEvents.value.length).toBe(3));
    await vi.waitFor((): any => expect(controller.eventsFollowing.value).toBe(false));
  });

  it("sends workspaceId only when a published workspace is chosen and rejects stale choices", async (): Promise<any> => {
    const workspaceEndpoint: any = {
      ...endpointFixture,
      publishedWorkspaces: [{ workspaceId: "ws.main", label: "Main workspace" }],
    };
    bridge.getJson.mockResolvedValue(inventory({ endpoints: [workspaceEndpoint] }));
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(workspaceEndpoint.endpointId);
    controller.capabilityId.value = "fixture.echo";
    controller.inputText.value = "{}";

    bridge.postJson.mockResolvedValueOnce({ task: makeTask({}), idempotent: false });
    await controller.submitTask();
    expect(bridge.postJson.mock.calls.at(-1)[1]).not.toHaveProperty("workspaceId");

    controller.workspaceId.value = "ws.main";
    bridge.postJson.mockResolvedValueOnce({ task: makeTask({}), idempotent: false });
    await controller.submitTask();
    expect(bridge.postJson.mock.calls.at(-1)[1].workspaceId).toBe("ws.main");

    controller.workspaceId.value = "ws.ghost";
    await controller.submitTask();
    expect(controller.error.value).toBe("workspaceUnavailable");
    expect(bridge.postJson).toHaveBeenCalledTimes(2);
  });

  it("resolves an org-level pending permission through the governed confirm", async (): Promise<any> => {
    const permission: any = {
      permissionId: "mperm_inbox",
      taskId: "mt_9",
      state: "pending",
      prompt: {
        sessionId: "fixture-session",
        toolCall: { title: "Fixture operation" },
        options: [{ optionId: "opt.deny", name: "Deny", kind: "deny" }],
      },
      selectedOptionId: null,
    };
    bridge.getJson.mockResolvedValue(inventory({ pendingPermissions: [permission] }));
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.orgPendingPermissions.value.length).toBe(1));
    bridge.postJson.mockResolvedValueOnce({ permission: { ...permission, state: "resolved" }, idempotent: false });
    await controller.resolvePendingPermission(permission, permission.prompt.options[0]);
    const call: any = bridge.postJson.mock.calls.at(-1);
    expect(call[0]).toBe("/api/endpoints/tasks/mt_9/permission");
    expect(call[1]).toEqual({
      taskId: "mt_9",
      permissionId: "mperm_inbox",
      selectedOptionId: "opt.deny",
    });
    expect(call[2]).toEqual({ safetyConfirm: true });
  });
});

async function mountWithDetail(access: any, detail: any): Promise<any> {
  bridge.getJson.mockResolvedValue(inventory({ tasks: [makeTask({ taskId: "mt_1" })] }));
  const wrapper: any = mountView(access);
  await vi.waitFor((): any =>
    expect(wrapper.find('[data-testid="managed-device-me_shared1"]').exists()).toBe(true),
  );
  await wrapper.find('[data-testid="managed-device-me_shared1"]').trigger("click");
  bridge.getJson.mockResolvedValueOnce(detail);
  await wrapper.find(".managed-task-item").trigger("click");
  await vi.waitFor((): any =>
    expect(wrapper.find(".managed-task-detail").exists()).toBe(true),
  );
  return wrapper;
}

describe("outcome and permission rendering", (): any => {
  it("renders a failed task result body and error code", async (): Promise<any> => {
    const wrapper: any = await mountWithDetail(makeAccess(), {
      task: makeTask({ state: "failed", result: { reason: "fixture failure" }, errorCode: "managed_exec_failed" }),
      workItem: null,
      pendingPermission: null,
    });
    const result: any = wrapper.find('[data-testid="managed-task-result"]');
    expect(result.exists()).toBe(true);
    expect(result.text()).toContain("fixture failure");
    expect(wrapper.find('[data-testid="managed-task-errorcode"]').text()).toBe("managed_exec_failed");
    expect(wrapper.text()).toContain("失败");
  });

  it("renders an unknown task as needing reconciliation, never as success", async (): Promise<any> => {
    const wrapper: any = await mountWithDetail(makeAccess(), {
      task: makeTask({ state: "unknown", result: { partial: true } }),
      workItem: null,
      pendingPermission: null,
    });
    expect(wrapper.text()).toContain("状态待核对");
    expect(wrapper.find(".managed-task-detail").text()).not.toContain("成功");
  });

  it("shows the full tool call and option names read-only without approve scope", async (): Promise<any> => {
    const access: any = makeAccess({ scopes: ref(["endpoints:read"]) });
    const wrapper: any = await mountWithDetail(access, {
      task: makeTask({ state: "leased" }),
      workItem: null,
      pendingPermission: {
        permissionId: "mperm_1",
        taskId: "mt_1",
        state: "pending",
        prompt: {
          sessionId: "fixture-session",
          toolCall: { toolCallId: "fixture-tool", title: "Fixture operation", rawInput: { x: 1 } },
          options: [{ optionId: " allow/once ", name: "Allow once", kind: "allow_once" }],
        },
        selectedOptionId: null,
      },
    });
    const toolcall: any = wrapper.find('[data-testid="managed-permission-toolcall"]');
    expect(toolcall.exists()).toBe(true);
    expect(toolcall.text()).toContain("Fixture operation");
    expect(toolcall.text()).toContain("fixture-tool");
    expect(wrapper.find(".managed-permission-options").text()).toContain("Allow once");
    expect(wrapper.find("[data-testid='managed-permission-option-Allow once']").exists()).toBe(false);
    expect(bridge.postJson).not.toHaveBeenCalled();
  });

  it("exposes the full JSON tail through a details panel beyond the preview limit", async (): Promise<any> => {
    const tail: any = `tail-${"y".repeat(5000)}`;
    const wrapper: any = await mountWithDetail(makeAccess(), {
      task: makeTask({ state: "succeeded", result: { blob: tail } }),
      workItem: null,
      pendingPermission: null,
    });
    const result: any = wrapper.find('[data-testid="managed-task-result"]');
    expect(result.text().length).toBeLessThan(5000);
    const full: any = wrapper.find(".managed-full-value");
    expect(full.exists()).toBe(true);
    expect(full.text()).toContain("显示完整内容");
    expect(full.find("pre").text()).toContain(tail.slice(-40));
  });
});

describe("selection, token and permission detail residuals", (): any => {
  it("selects a newly created endpoint and invalidates the previous task detail", async (): Promise<any> => {
    const newEndpoint: any = {
      ...endpointFixture,
      endpointId: "me_new1",
      label: "Device B",
      allowedCapabilityIds: [],
      catalog: [],
    };
    const detailGate: any = deferred<any>();
    bridge.getJson
      .mockResolvedValueOnce(inventory())
      .mockImplementationOnce((): any => detailGate.promise)
      .mockResolvedValueOnce(inventory({ endpoints: [endpointFixture, newEndpoint] }));
    bridge.postJson.mockResolvedValueOnce({
      endpoint: newEndpoint,
      enrollmentToken: newEnrollmentToken(),
    });
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.selectEndpoint(endpointFixture.endpointId);
    controller.selectTask("mt_1");
    await controller.createEndpoint();
    expect(controller.selectedEndpointId.value).toBe("me_new1");
    expect(controller.selectedTaskId.value).toBe("");
    expect(controller.taskDetail.value).toBeNull();
    detailGate.resolve({
      task: makeTask({ taskId: "mt_1", endpointId: endpointFixture.endpointId }),
      workItem: null,
      pendingPermission: null,
    });
    await detailGate.promise;
    await nextTick();
    expect(controller.selectedEndpointId.value).toBe("me_new1");
    expect(controller.selectedTaskId.value).toBe("");
    expect(controller.taskDetail.value).toBeNull();
  });

  it("never marks a replaced token copied when a stale clipboard write resolves late", async (): Promise<any> => {
    const writeGate: any = deferred<any>();
    const writeText: any = vi.fn((): any => writeGate.promise);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { controller } = mountController();
    await vi.waitFor((): any => expect(controller.endpoints.value.length).toBe(1));
    controller.enrollmentToken.value = newEnrollmentToken();
    void controller.copyToken();
    controller.enrollmentToken.value = newEnrollmentToken();
    controller.tokenCopied.value = false;
    writeGate.resolve(undefined);
    await writeGate.promise;
    await nextTick();
    expect(controller.tokenCopied.value).toBe(false);

    const rejectGate: any = deferred<any>();
    writeText.mockImplementation((): any => rejectGate.promise);
    void controller.copyToken();
    controller.enrollmentToken.value = newEnrollmentToken();
    controller.tokenCopied.value = false;
    rejectGate.reject(new Error("denied"));
    await rejectGate.promise.catch((): any => undefined);
    await nextTick();
    expect(controller.tokenCopied.value).toBe(false);
  });

  it("exposes the full permission toolCall tail for readers and approvers", async (): Promise<any> => {
    const tail: any = `perm-${"z".repeat(5000)}`;
    const detail: any = {
      task: makeTask({ state: "leased" }),
      workItem: null,
      pendingPermission: {
        permissionId: "mperm_1",
        taskId: "mt_1",
        state: "pending",
        prompt: {
          sessionId: "fixture-session",
          toolCall: {
            toolCallId: "fixture-tool",
            title: "Fixture operation",
            rawInput: { blob: tail },
          },
          options: [{ optionId: " allow/once ", name: "Allow once", kind: "allow_once" }],
        },
        selectedOptionId: null,
      },
    };
    const reader: any = await mountWithDetail(
      makeAccess({ scopes: ref(["endpoints:read"]) }),
      detail,
    );
    expect(reader.find('[data-testid="managed-permission-toolcall"]').text()).toContain(
      tail.slice(-40),
    );
    const approver: any = await mountWithDetail(makeAccess(), detail);
    expect(approver.find('[data-testid="managed-permission-toolcall"]').text()).toContain(
      tail.slice(-40),
    );
  });
});
