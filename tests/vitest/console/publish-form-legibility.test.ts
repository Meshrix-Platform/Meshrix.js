// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { createMemoryHistory, createRouter, createWebHashHistory } from "vue-router";
import PublishServiceForm from "../../../apps/console/views/admin/upstream-service-publish/PublishServiceForm.vue";
import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import {
  clearConsoleToasts,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";

const client: any = vi.hoisted(() : any => ({
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

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client,
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));

import { unregisterConsoleConfirmHost } from "../../../apps/console/composables/console-confirm-controller";

function emptyForm(): any {
  return {
    serviceKey: "",
    label: "",
    description: "",
    serviceProtocol: "",
    baseUrl: "",
    operations: [],
    references: [],
    operationKey: "",
    method: "",
    path: "",
    risk: "",
    requestRepresentationMode: "",
    responseRepresentationMode: "",
    requestMaxBytes: "",
    responseMaxBytes: "",
    requestMediaTypes: "",
    responseMediaTypes: "",
    credentialMode: "none",
    credentialSelection: "",
    savedCredentialOptions: [],
  };
}

const mountedWrappers: any[] = [];

async function mountForm(overrides: Record<string, any> = {}) : Promise<any> {
  const router: any = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div />" } }],
  });
  await router.push("/");
  await router.isReady();
  const form: any = reactive({ ...emptyForm(), ...overrides });
  const wrapper: any = mount(PublishServiceForm, {
    props: { form },
    attachTo: document.body,
    global: { plugins: [router] },
  });
  mountedWrappers.push(wrapper);
  await nextTick();
  return { wrapper, form };
}

async function clickTab(wrapper: any, label: string) : Promise<any> {
  const tab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.text() === label);
  expect(tab).toBeDefined();
  await tab.trigger("click");
  await nextTick();
}

function tabClasses(wrapper: any, label: string) : string[] {
  const tab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.text() === label);
  return tab ? tab.classes() : [];
}

async function fillValidRequest(wrapper: any, operationKey: string, method: string, path: string) : Promise<any> {
  await wrapper.find("#operationKey").setValue(operationKey);
  await wrapper.find("#method").setValue(method);
  await wrapper.find("#path").setValue(path);
  await wrapper.find("#requestRepresentationMode").setValue("structured_json");
  await wrapper.find("#requestMaxBytes").setValue("1024");
  await wrapper.find("#requestMediaTypes").setValue("application/json");
}

async function mountView() : Promise<any> {
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
  return { wrapper, router };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  pageRefreshHandler.mockClear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
  // jsdom does not implement scrollIntoView; the focus/scroll helper calls it.
  (HTMLElement.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
  clearConsoleToasts();
  unregisterConsoleConfirmHost();
  while (mountedWrappers.length) {
    mountedWrappers.pop()!.unmount();
  }
});

describe("PublishServiceForm per-field rule mapping (REQ-007 store)", () : any => {
  it("maps the required-tool-path guard to its four distinct fields", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();

    for (const field of ["operationKey", "method", "path", "requestRepresentationMode"]) {
      const region: any = wrapper.find(`#console-field-${field}-error`);
      expect(region.exists()).toBe(true);
      expect(region.text()).toBe("Complete all required tool path fields.");
    }
    // Guard 1 expands into exactly its four fields — no stray errors.
    expect(wrapper.findAll(".console-form-field-error")).toHaveLength(4);
  });

  it("maps the request byte-limit guard to requestMaxBytes", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await fillValidRequest(wrapper, "download", "GET", "/download");
    // Everything valid except the byte limit (still empty).
    await wrapper.find("#requestMaxBytes").setValue("");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();

    const region: any = wrapper.find("#console-field-requestMaxBytes-error");
    expect(region.exists()).toBe(true);
    expect(region.text()).toBe("Request byte limits must be positive whole numbers.");
    expect(wrapper.findAll(".console-form-field-error")).toHaveLength(1);
  });

  it("maps the request media-types guard to requestMediaTypes", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await fillValidRequest(wrapper, "download", "GET", "/download");
    await wrapper.find("#requestMediaTypes").setValue("");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();

    const region: any = wrapper.find("#console-field-requestMediaTypes-error");
    expect(region.exists()).toBe(true);
    expect(region.text()).toBe("Add at least one request media type.");
  });

  it("maps the response-configuration guard to its three response fields", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await fillValidRequest(wrapper, "download", "GET", "/download");
    // A partial response configuration (only maxBytes, invalid value) trips
    // guard 4 on all three response fields.
    await wrapper.find("#responseMaxBytes").setValue("0");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();

    for (const field of ["responseRepresentationMode", "responseMaxBytes", "responseMediaTypes"]) {
      const region: any = wrapper.find(`#console-field-${field}-error`);
      expect(region.exists()).toBe(true);
      expect(region.text()).toBe("Complete all response fields, or leave the optional response configuration empty.");
    }
  });

  it("maps the JSON-RPC structured-JSON guard to both representation fields", async () : Promise<any> => {
    const { wrapper } = await mountForm({ serviceProtocol: "json-rpc" });
    await clickTab(wrapper, "Tool paths");
    await fillValidRequest(wrapper, "rpc-list", "POST", "/rpc");
    await wrapper.find("#requestRepresentationMode").setValue("opaque_stream");
    // Response configuration left empty: guard 4 passes (optional), guard 5
    // fails for both directions.
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();

    const message = "JSON-RPC tool paths require Structured JSON for both request and response.";
    expect(wrapper.find("#console-field-requestRepresentationMode-error").text()).toBe(message);
    expect(wrapper.find("#console-field-responseRepresentationMode-error").text()).toBe(message);
  });

  it("maps the duplicate-identifier guard to operationKey", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await fillValidRequest(wrapper, "list-items", "GET", "/items");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);

    await fillValidRequest(wrapper, "list-items", "POST", "/other");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    expect(wrapper.find("#console-field-operationKey-error").text()).toBe(
      "Tool identifiers must be unique within a service.",
    );
    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
  });

  it("clears a field error on edit and keeps the remaining per-field errors", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    expect(wrapper.find("#console-field-operationKey-error").exists()).toBe(true);

    await wrapper.find("#operationKey").setValue("download");
    await nextTick();
    expect(wrapper.find("#console-field-operationKey-error").exists()).toBe(false);
    expect(wrapper.find("#console-field-method-error").exists()).toBe(true);
  });
});

describe("PublishServiceForm tab validity badges", () : any => {
  it("flags the operations tab when any of its fields has an error and clears on success", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    expect(tabClasses(wrapper, "Tool paths")).not.toContain("meshrix-tab--draft");

    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    expect(tabClasses(wrapper, "Tool paths")).toContain("meshrix-tab--draft");
    expect(tabClasses(wrapper, "Service information")).not.toContain("meshrix-tab--draft");
    expect(tabClasses(wrapper, "Access credentials")).not.toContain("meshrix-tab--draft");
    expect(tabClasses(wrapper, "Advanced JSON")).not.toContain("meshrix-tab--draft");

    // Fixing every field and adding successfully clears the flag.
    await fillValidRequest(wrapper, "download", "GET", "/download");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    expect(tabClasses(wrapper, "Tool paths")).not.toContain("meshrix-tab--draft");
  });

  it("falls back to a tab-level badge when a rule has no per-field mapping", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Access credentials");
    await wrapper.find("#upstream-service-credential-mode").setValue("saved");
    await nextTick();

    // The credential guidance error is not a store field error — the tab badge
    // is the fallback surface, and the legacy inline rendering is preserved.
    expect(tabClasses(wrapper, "Access credentials")).toContain("meshrix-tab--draft");
    expect(wrapper.find(".console-inline-alert").text()).toContain("No saved credentials are available.");
    expect(wrapper.find("#console-field-credentialSelection-error").exists()).toBe(false);
  });
});

describe("PublishServiceForm protocol and credential affordances", () : any => {
  it("renders the Protocol required marker and aria-required on the select", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    const select: any = wrapper.find("#upstream-service-protocol");
    expect(select.attributes("aria-required")).toBe("true");
    const marker: any = wrapper.find(".console-form-field-required-marker");
    expect(marker.exists()).toBe(true);
    expect(marker.text()).toBe("*");
    expect(marker.attributes("aria-hidden")).toBe("true");
  });

  it("links the credential guidance to the credential-saving surface", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Access credentials");
    await wrapper.find("#upstream-service-credential-mode").setValue("saved");
    await nextTick();

    const link: any = wrapper.find("a.credential-save-link");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("/admin/api-key-distribution");
    expect(link.text()).toBe(consoleMessages[currentConsoleLocale.value].publishForm.credentialSaveLink);
    expect(consoleMessages["zh-CN"].publishForm.credentialSaveLink).toBeTruthy();
    expect(consoleMessages.en.publishForm.credentialSaveLink).toBeTruthy();
  });
});

describe("PublishServiceForm exposed focusFirstInvalid", () : any => {
  it("activates the first invalid tab and focuses its first invalid field", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await nextTick();
    // A second, later-ordered invalid tab exists too — operations must win.
    await clickTab(wrapper, "Access credentials");
    await wrapper.find("#upstream-service-credential-mode").setValue("saved");
    await nextTick();
    await clickTab(wrapper, "Service information");
    // Let the URL-held tab state settle before the exposed call writes it back.
    await flushPromises();

    const focused: boolean = await (wrapper.vm as any).focusFirstInvalid();
    await nextTick();
    await nextTick();
    expect(focused).toBe(true);
    const activeTab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.classes().includes("meshrix-tab--active"));
    expect(activeTab.text()).toBe("Tool paths");
    expect(document.activeElement?.id).toBe("operationKey");
  });

  it("reports false when the form has no validation errors", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Tool paths");
    expect(await (wrapper.vm as any).focusFirstInvalid()).toBe(false);
  });

  it("activates the credentials tab when only the unmapped credential rule fails", async () : Promise<any> => {
    const { wrapper } = await mountForm();
    await clickTab(wrapper, "Access credentials");
    await wrapper.find("#upstream-service-credential-mode").setValue("saved");
    await nextTick();
    await clickTab(wrapper, "Service information");
    // Let the URL-held tab state settle before the exposed call writes it back.
    await flushPromises();

    const focused: boolean = await (wrapper.vm as any).focusFirstInvalid();
    await nextTick();
    await nextTick();
    expect(focused).toBe(true);
    const activeTab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.classes().includes("meshrix-tab--active"));
    expect(activeTab.text()).toBe("Access credentials");
  });
});

describe("failed submit wiring (view consumes focusFirstInvalid)", () : any => {
  it("activates the first invalid tab and focuses its first invalid field on failed publish", async () : Promise<any> => {
    const { wrapper } = await mountView();

    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await flushPromises();
    expect(tabClasses(wrapper, "Tool paths")).toContain("meshrix-tab--draft");

    await clickTab(wrapper, "Service information");
    // Let the URL-held tab state settle before the submit writes it back.
    await flushPromises();
    await wrapper.find("#upstream-service-key").setValue("inventory");
    await wrapper.find("#upstream-service-protocol").setValue("http");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();
    await nextTick();
    await nextTick();

    const activeTab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.classes().includes("meshrix-tab--active"));
    expect(activeTab.text()).toBe("Tool paths");
    expect(document.activeElement?.id).toBe("operationKey");
    // Client validation failures land in the form — no page-level alert, no
    // server call.
    expect(wrapper.find(".upstream-publish-layout > .console-inline-alert").exists()).toBe(false);
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("runs the form validation gate before the page-level protocol guard", async () : Promise<any> => {
    const { wrapper } = await mountView();

    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    await flushPromises();
    await clickTab(wrapper, "Service information");
    // Let the URL-held tab state settle before the submit writes it back.
    await flushPromises();
    await wrapper.find("#upstream-service-key").setValue("inventory");
    // Protocol deliberately left empty: the page-level guard must not fire —
    // the form errors are surfaced first.
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();
    await nextTick();
    await nextTick();

    const activeTab: any = wrapper.findAll('[role="tab"]').find((candidate?: any) : any => candidate.classes().includes("meshrix-tab--active"));
    expect(activeTab.text()).toBe("Tool paths");
    expect(document.activeElement?.id).toBe("operationKey");
    expect(wrapper.text()).not.toContain("Protocol must be selected explicitly.");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("PublishServiceForm preserved behaviors", () : any => {
  it("keeps the removeOperation undo toast and in-place restore", async () : Promise<any> => {
    const { wrapper, form } = await mountForm({
      operations: [{
        operationKey: "list-items",
        method: "GET",
        path: "/api/items",
        payloadTransport: { request: { mode: "structured_json" } },
      }],
    });
    await clickTab(wrapper, "Tool paths");
    await wrapper.find(".inline-remove").trigger("click");

    expect(form.operations).toHaveLength(0);
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(consoleMessages[currentConsoleLocale.value].toast.toolPathRemoved);
    expect(toasts[0].action?.label).toBe(consoleMessages[currentConsoleLocale.value].toast.undo);

    toasts[0].action.run();
    expect(form.operations).toHaveLength(1);
    expect(form.operations[0].operationKey).toBe("list-items");
  });

  it("leaves the Advanced JSON tab unchanged", async () : Promise<any> => {
    const { wrapper } = await mountForm({
      operations: [{
        operationKey: "list",
        method: "GET",
        path: "/items",
        requiresApproval: false,
        payloadTransport: { request: { mode: "structured_json", maxBytes: 1024 } },
      }],
    });
    await clickTab(wrapper, "Advanced JSON");

    const descriptors: any = wrapper.find('[aria-label="Imported tool descriptors"]');
    expect(descriptors.exists()).toBe(true);
    expect(descriptors.find(".operation-descriptor-summary").text()).toContain("list");
    expect(descriptors.find(".operation-descriptor-summary").text()).toContain("GET /items");
    expect(descriptors.find(".operation-descriptor-summary").text()).toContain("maxBytes 1024");
    expect(descriptors.find("pre").text()).toContain('"maxBytes": 1024');
    expect(wrapper.findAllComponents({ name: "JsonConfigFileEditor" })).toHaveLength(7);
    expect(tabClasses(wrapper, "Advanced JSON")).not.toContain("meshrix-tab--draft");
    expect(wrapper.findAll(".console-form-field-error")).toHaveLength(0);
  });
});
