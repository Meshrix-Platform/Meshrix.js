// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client: any = vi.hoisted(() : any => ({
  createUpstreamService: vi.fn(),
  replaceUpstreamService: vi.fn(),
  disableUpstreamService: vi.fn(),
  republishUpstreamService: vi.fn(),
  removeUpstreamService: vi.fn(),
  listPublishedServices: vi.fn(),
  getPublishedService: vi.fn(),
  waitForUpstreamServicePublication: vi.fn(),
  checkUpstreamServiceRuntimeHealth: vi.fn()
}));
const route: any = vi.hoisted(() : any => ({ query: {} }));
const triggerBrowserDownload: any = vi.hoisted(() : any => vi.fn());
const pageRefreshHandler: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client
}));
vi.mock("vue-router", () : any => ({
  useRoute: () : any => route,
  useRouter: () : any => ({
    replace: (location: any) : any => {
      if (location?.query) {
        route.query = { ...location.query };
      }
      return Promise.resolve();
    },
  }),
}));
vi.mock("@meshrix/ui-console/browser-downloads", () : any => ({
  triggerBrowserDownload,
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));

import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import { parsePortableUpstreamServiceImport } from "@meshrix/contracts/upstream-service-publishing";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";

function publication(revision: number, digest: any = "a".repeat(64)) : any {
  return {
    publicationRef: `urn:meshrix:upstream-publication:${revision}`,
    status: "publishing" as const,
    candidateRevision: revision,
    candidateDigest: digest
  };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  pageRefreshHandler.mockClear();
  window.localStorage.clear();
  route.query = {};
  client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
  client.createUpstreamService.mockResolvedValue({
    ok: true,
    serviceId: "svc_fixture",
    state: "publishing",
    serviceRevision: 1,
    setRevision: 1,
    manifestDigest: "a".repeat(64),
    receiptRef: "urn:meshrix:receipt:fixture",
    publication: publication(1),
    replayed: false
  });
  client.waitForUpstreamServicePublication.mockResolvedValue({
    ok: true,
    setRevision: 1,
    service: {
      serviceId: "svc_fixture",
      state: "server_published",
      serviceRevision: 1,
      manifestDigest: "a".repeat(64),
      publication: { ...publication(1), status: "server_published" }
    }
  });
  client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: true, status: "healthy" });
});

describe("UpstreamServicePublishView configuration truthfulness", () : any => {
  it("saves a partial form locally and restores it without publishing", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find('#upstream-service-key').setValue("inventory-draft");
    await wrapper.find('#upstream-service-url').setValue("https://service.invalid:443");
    const toolPathsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Tool paths");
    await toolPathsTab.trigger("click");
    await wrapper.find('.operation-builder input').setValue("list-items");
    const saveButton: any = wrapper.findAll('.form-actions button').find((button?: any) : any => button.text() === "Save");
    await saveButton.trigger("click");

    expect(wrapper.text()).toContain(consoleMessages[currentConsoleLocale.value].publishDraft.saved);
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(1);
    wrapper.unmount();

    const restored: any = mount(UpstreamServicePublishView);
    await flushPromises();
    // REQ-008: the previously active tab is restored from the URL; switch back
    // to the basic tab for the restored-field assertions.
    const restoredBasicTab: any = restored.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Service information");
    await restoredBasicTab.trigger("click");
    expect((restored.find('#upstream-service-key').element as HTMLInputElement).value).toBe("inventory-draft");
    expect((restored.find('#upstream-service-url').element as HTMLInputElement).value).toBe("https://service.invalid:443");
    expect(restored.text()).toContain(consoleMessages[currentConsoleLocale.value].publishDraft.restored);
    const restoredToolPathsTab: any = restored.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Tool paths");
    await restoredToolPathsTab.trigger("click");
    expect((restored.find('.operation-builder input').element as HTMLInputElement).value).toBe("list-items");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
  });

  it("restores a saved edit after reloading the selected service route", async () : Promise<any> => {
    route.query = { serviceId: "svc_fixture" };
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 3,
      service: {
        serviceId: "svc_fixture",
        state: "server_published",
        serviceRevision: 2,
        manifestDigest: "a".repeat(64),
        publication: { ...publication(2), status: "server_published" },
        descriptor: { serviceProtocol: "http", label: "Published name", baseUrl: "https://service.invalid:443", operations: [] },
        references: [],
      },
    });
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await wrapper.find('#upstream-service-name').setValue("Unpublished local edit");
    const saveButton: any = wrapper.findAll('.form-actions button').find((button?: any) : any => button.text() === "Save");
    await saveButton.trigger("click");
    wrapper.unmount();

    const restored: any = mount(UpstreamServicePublishView);
    await flushPromises();
    expect((restored.find('#upstream-service-name').element as HTMLInputElement).value).toBe("Unpublished local edit");
    expect(restored.text()).toContain(consoleMessages[currentConsoleLocale.value].publishDraft.restored);
    expect(client.replaceUpstreamService).not.toHaveBeenCalled();
  });

  it("starts empty and submits only explicitly entered configuration", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    expect(wrapper.text()).not.toContain("Published Services");
    expect(wrapper.find(".publish-grid .publish-panel").exists()).toBe(false);

    const protocol: any = wrapper.find('select');
    expect((protocol.element as HTMLSelectElement).value).toBe("");
    expect((protocol.element as HTMLSelectElement).selectedIndex).toBe(0);
    expect(wrapper.text()).not.toContain("MCP");

    await wrapper.find('#upstream-service-key').setValue("inventory");
    await protocol.setValue("http");
    await wrapper.find('#upstream-service-url').setValue("https://service.invalid");
    const saveButton: any = wrapper.findAll('.form-actions button').find((button?: any) : any => button.text() === "Save");
    await saveButton.trigger("click");
    expect(window.localStorage.length).toBe(1);
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory", {
      serviceProtocol: "http",
      baseUrl: "https://service.invalid",
      operations: [],
      references: []
    }, 0);
    const descriptor: any = client.createUpstreamService.mock.calls[0][1];
    expect(descriptor).not.toHaveProperty("visibility");
    expect(descriptor).not.toHaveProperty("trafficPolicy");
    expect(client.waitForUpstreamServicePublication).toHaveBeenCalledWith("svc_fixture");
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    expect(window.localStorage.length).toBe(0);
    expect(wrapper.text()).toContain('"status": "healthy"');
  });

  it("registers the title-bar page refresh handler without rendering duplicate toolbar actions", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    expect(wrapper.find(".publish-toolbar").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("New Service");
    expect(wrapper.text()).not.toContain("Refresh");
    expect(wrapper.findAll('.form-actions button').map((button?: any) : any => button.text())).toContain("Save");

    expect(pageRefreshHandler).toHaveBeenCalledTimes(1);
    const [predicate, handler]: [(detail: Record<string, string>) => boolean, () => Promise<unknown>] = pageRefreshHandler.mock.calls[0];
    expect(predicate({
      viewId: "admin",
      adminView: "upstreamServicePublish",
      gatewayTab: "",
      debugTab: "",
      routePath: "/admin/publish-upstream-service",
    })).toBe(true);
    client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 9, services: [] });
    const refreshCallCount = client.listPublishedServices.mock.calls.length;
    await handler();
    expect(client.listPublishedServices.mock.calls.length).toBe(refreshCallCount + 1);
  });

  it("orders external connection fields before Meshrix metadata and explains the service identifier", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const fieldLabels: string[] = wrapper.findAll('.tab-content > .form-field').map((field: any) : string =>
      field.find("label, span").text()
    );
    expect(fieldLabels).toEqual([
      "Protocol",
      "Service URL *",
      "Service identifier *",
      "Service name",
      "Service description",
      "Visibility",
      "Data class",
      "Tags",
    ]);
    expect(wrapper.findAll(".help-tooltip-trigger")).toHaveLength(8);
    expect(wrapper.find('[aria-label="Protocol help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Service URL help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Service name help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Service description help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Visibility help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Data class help"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Tags help"]').exists()).toBe(true);
    const helpTrigger: any = wrapper.find('[aria-label="Service identifier help"]');

    expect(helpTrigger.exists()).toBe(true);
    await helpTrigger.trigger("mouseenter");
    await flushPromises();
    const tooltip: Element | null = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain("A unique, stable identifier");
    expect(tooltip?.textContent).toContain("inventory-api");
    expect(helpTrigger.attributes("aria-describedby")).toBeTruthy();

    await helpTrigger.trigger("mouseleave");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    await helpTrigger.trigger("focus");
    await flushPromises();
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    wrapper.unmount();
  });

  it("uses an optional access-credential selector instead of manual reference fields", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    const credentialsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Access credentials");
    expect(credentialsTab).toBeDefined();
    await credentialsTab!.trigger("click");

    const mode: any = wrapper.find("#upstream-service-credential-mode");
    expect((mode.element as HTMLSelectElement).value).toBe("none");
    expect(mode.text()).toContain("No authentication");
    expect(mode.text()).toContain("Select saved credential");
    expect(wrapper.find('input[placeholder*="credential://"]').exists()).toBe(false);
    expect(wrapper.find("#upstream-service-saved-credential").exists()).toBe(false);

    await mode.setValue("saved");
    expect(wrapper.find("#upstream-service-saved-credential").exists()).toBe(true);
    expect(wrapper.find("#upstream-service-saved-credential").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("No saved credentials are available");
    wrapper.unmount();
  });

  it("loads saved credential choices without exposing a URI entry field", async () : Promise<any> => {
    route.query = { serviceId: "svc_fixture" };
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 3,
      service: {
        serviceId: "svc_fixture",
        state: "server_published",
        serviceRevision: 2,
        manifestDigest: "a".repeat(64),
        publication: { ...publication(2), status: "server_published" },
        descriptor: { serviceProtocol: "http", baseUrl: "https://service.invalid:443", operations: [] },
        references: [{ type: "credential", reference: "secret://vault/catalog", revision: 4, use: "request-auth" }],
      },
    });

    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const credentialsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Access credentials");
    await credentialsTab!.trigger("click");

    expect((wrapper.find("#upstream-service-credential-mode").element as HTMLSelectElement).value).toBe("saved");
    const savedCredential: any = wrapper.find("#upstream-service-saved-credential");
    expect((savedCredential.element as HTMLSelectElement).value).toBe("0");
    expect(savedCredential.text()).toContain("request-auth (revision 4)");
    expect(savedCredential.text()).not.toContain("secret://vault/catalog");
    wrapper.unmount();
    expect(wrapper.find('input[placeholder*="credential://"]').exists()).toBe(false);
  });

  it("imports a strict portable document without publishing and preserves the draft on errors", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const serviceKey: any = wrapper.find('#upstream-service-key');
    await serviceKey.setValue("existing-draft");
    const importer: any = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    const textarea: any = importer.find("textarea");
    const validate: any = importer.find('[data-action="validate-service-json"]');
    const loadDraft: any = importer.find('[data-action="load-service-draft"]');

    expect(loadDraft.attributes("disabled")).toBeDefined();

    await textarea.setValue('{"kind":"wrong","schemaVersion":"v0.0.1:upstream-service:portable-import-2","serviceKey":"replacement","descriptor":{}}');
    await validate.trigger("click");
    await flushPromises();
    expect((serviceKey.element as HTMLInputElement).value).toBe("existing-draft");
    expect(importer.text()).toContain('kind must be "meshrix.upstream-service"');
    expect(loadDraft.attributes("disabled")).toBeDefined();

    await textarea.setValue(JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "replacement",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        tags: ["portable"],
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    }));
    await validate.trigger("click");
    await flushPromises();
    expect(importer.text()).toContain("Configuration format is valid.");
    expect((serviceKey.element as HTMLInputElement).value).toBe("existing-draft");
    expect(loadDraft.attributes("disabled")).toBeUndefined();

    await textarea.setValue(`${(textarea.element as HTMLTextAreaElement).value} `);
    expect(importer.text()).not.toContain("Configuration format is valid.");
    expect(loadDraft.attributes("disabled")).toBeDefined();
    await validate.trigger("click");

    await loadDraft.trigger("click");
    await flushPromises();
    expect((serviceKey.element as HTMLInputElement).value).toBe("replacement");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Draft loaded. Review it, then select Publish.");
    wrapper.unmount();
  });

  it("loads a selected local file without importing or publishing it", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer: any = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    const fileText: any = JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "inventory",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    });
    const file: any = new File([fileText], "service.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(fileText) });
    const fileInput: any = importer.find('input[type="file"]');
    Object.defineProperty(fileInput.element, "files", { configurable: true, value: [file] });
    await fileInput.trigger("change");
    await flushPromises();

    expect((importer.find("textarea").element as HTMLTextAreaElement).value).toBe(fileText);
    expect(importer.text()).toContain("Loaded file: service.json");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.find('#upstream-service-key').element).toHaveProperty("value", "");
  });

  it("downloads a canonical portable JSON template without loading or publishing it", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer: any = wrapper.findComponent({ name: "PortableServiceImportPanel" });

    await importer.find('[data-action="download-service-json-template"]').trigger("click");

    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1);
    const [blob, fileName]: [Blob, string] = triggerBrowserDownload.mock.calls[0];
    expect(blob.type).toBe("application/json;charset=utf-8");
    expect(fileName).toBe("meshrix-upstream-service-template.json");
    const templateText: string = await new Promise((resolve, reject) : any => {
      const reader: FileReader = new FileReader();
      reader.onload = () : any => resolve(String(reader.result));
      reader.onerror = () : any => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(() : any => parsePortableUpstreamServiceImport(templateText)).not.toThrow();
    expect((importer.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(client.createUpstreamService).not.toHaveBeenCalled();
  });

  it("loads an imported draft before the single explicit publish action", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer: any = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    await importer.find("textarea").setValue(JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "inventory",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        healthPath: "/healthz",
        operations: [{
          operationKey: "list", method: "GET", path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
          }
        }]
      }
    }));
    await importer.find('[data-action="validate-service-json"]').trigger("click");
    await importer.find('[data-action="load-service-draft"]').trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Review it, then select Publish");

    const advancedTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Advanced JSON");
    expect(advancedTab).toBeDefined();
    await advancedTab!.trigger("click");
    const operationDescriptors: any = wrapper.find('[aria-label="Imported tool descriptors"]');
    expect(operationDescriptors.exists()).toBe(true);
    expect(operationDescriptors.find(".operation-descriptor-summary").text()).toContain("list");
    expect(operationDescriptors.find(".operation-descriptor-summary").text()).toContain("GET /items");
    expect(operationDescriptors.find(".operation-descriptor-summary").text()).toContain("Approval: not required");
    expect(operationDescriptors.find(".operation-descriptor-summary").text()).toContain("maxBytes 1024");
    expect(operationDescriptors.find("pre").text()).toContain('"maxBytes": 1024');
    expect(operationDescriptors.find("pre").text()).toContain('"mode": "structured_json"');

    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory", {
      serviceProtocol: "http",
      baseUrl: "https://service.invalid:443",
      healthPath: "/healthz",
      operations: [{
        operationKey: "list", method: "GET", path: "/items",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
        }
      }],
      references: []
    }, 0);
    expect(client.waitForUpstreamServicePublication).toHaveBeenCalledWith("svc_fixture");
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
  });

  it("labels operation fields, reports invalid drafts, and applies protocol-specific representation rules", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find(".publish-form select").setValue("http");
    const operationsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Tool paths");
    expect(operationsTab).toBeDefined();
    await operationsTab!.trigger("click");

    const fields: any = wrapper.findAll(".operation-builder .form-field");
    expect(fields.map((field?: any) : any => field.find("span").text())).toEqual([
      "Tool identifier *",
      "Method *",
      "Path *",
      "Risk",
      "Representation *",
      "Maximum bytes *",
      "Media types *",
      "Representation",
      "Maximum bytes",
      "Media types",
    ]);
    expect((fields[3].find("select").element as HTMLSelectElement).value).toBe("");
    expect((fields[1].find("select").element as HTMLSelectElement).selectedIndex).toBe(0);
    expect((fields[3].find("select").element as HTMLSelectElement).selectedIndex).toBe(0);

    await wrapper.find(".operation-builder .table-action").trigger("click");
    expect(wrapper.text()).toContain("Complete all required tool path fields.");

    await fields[0].find("input").setValue("download");
    await fields[1].find("select").setValue("GET");
    await fields[2].find("input").setValue("/download");
    await fields[4].find("select").setValue("opaque_stream");
    await fields[5].find("input").setValue("1024");
    await fields[6].find("input").setValue("application/octet-stream");
    await fields[7].find("select").setValue("structured_json");
    await fields[8].find("input").setValue("2048");
    await fields[9].find("input").setValue("application/json");
    await wrapper.find(".operation-builder .table-action").trigger("click");

    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
    expect(wrapper.text()).toContain("opaque_stream → structured_json");

    const basicTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Service information");
    await basicTab!.trigger("click");
    await wrapper.find(".publish-form select").setValue("json-rpc");
    await operationsTab!.trigger("click");
    const jsonRpcFields: any = wrapper.findAll(".operation-builder .form-field");
    await jsonRpcFields[0].find("input").setValue("rpc-download");
    await jsonRpcFields[1].find("select").setValue("POST");
    await jsonRpcFields[2].find("input").setValue("/rpc");
    await jsonRpcFields[4].find("select").setValue("opaque_stream");
    await jsonRpcFields[5].find("input").setValue("1024");
    await jsonRpcFields[6].find("input").setValue("application/octet-stream");
    await jsonRpcFields[7].find("select").setValue("structured_json");
    await jsonRpcFields[8].find("input").setValue("2048");
    await jsonRpcFields[9].find("input").setValue("application/json");
    await wrapper.find(".operation-builder .table-action").trigger("click");

    expect(wrapper.text()).toContain("JSON-RPC tool paths require Structured JSON for both request and response.");
    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
    wrapper.unmount();
  });

  it("allows an HTTP tool path to omit response settings for governed passthrough", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find(".publish-form select").setValue("http");
    const operationsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Tool paths");
    await operationsTab!.trigger("click");
    const fields: any = wrapper.findAll(".operation-builder .form-field");
    const responseHelp: any = wrapper.find('[aria-label="Response help"]');
    expect(responseHelp.exists()).toBe(true);
    await responseHelp.trigger("mouseenter");
    await flushPromises();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain("Leave empty to use governed native passthrough.");
    await responseHelp.trigger("mouseleave");
    await fields[0].find("input").setValue("passthrough");
    await fields[1].find("select").setValue("GET");
    await fields[2].find("input").setValue("/passthrough");
    await fields[4].find("select").setValue("structured_json");
    await fields[5].find("input").setValue("1024");
    await fields[6].find("input").setValue("application/json");
    await wrapper.find(".operation-builder .table-action").trigger("click");

    expect(wrapper.findAll(".op-list > li")).toHaveLength(1);
    expect((wrapper.vm as any).form.operations[0].payloadTransport).not.toHaveProperty("response");
    expect(wrapper.find(".op-list > li").text()).toContain("governed passthrough");
    expect(wrapper.find(".op-list > li").text()).not.toContain("Complete all response fields");
    wrapper.unmount();
  });

  it("accepts portable HTTP descriptors without a response transport", () : any => {
    expect(() => parsePortableUpstreamServiceImport(JSON.stringify({
      kind: "meshrix.upstream-service",
      schemaVersion: "v0.0.1:upstream-service:portable-import-2",
      serviceKey: "passthrough",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        operations: [{
          operationKey: "get",
          method: "GET",
          path: "/items",
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] }
          }
        }]
      }
    }))).not.toThrow();
  });

  it("keeps publication evidence while reporting a failed runtime health result", async () : Promise<any> => {
    client.checkUpstreamServiceRuntimeHealth.mockResolvedValue({ ok: false, status: "unhealthy" });
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await wrapper.find('#upstream-service-key').setValue("inventory");
    await wrapper.find('.publish-form select').setValue("http");
    await wrapper.find('#upstream-service-url').setValue("https://service.invalid:443");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("server-published, but runtime health did not pass");
    expect(wrapper.find(".tone-danger").exists()).toBe(true);
    expect(wrapper.text()).toContain('"status": "unhealthy"');
  });

  it("loads and replaces the complete descriptor with both current revisions", async () : Promise<any> => {
    const descriptor: Record<string, any> = {
      serviceProtocol: "json-rpc" as const,
      label: "Catalog",
      baseUrl: "https://service.invalid/rpc",
      visibility: "organization",
      dataClass: "internal",
      tags: ["catalog"],
      interfaceSchemas: { request: { type: "object" } },
      permissions: { requiredScopes: ["catalog:read"] },
      approvalPolicy: { required: true },
      trafficPolicy: { perMinute: 20 },
      audience: { organizations: ["org-a"], teams: ["team-a"], roles: ["maintainer"], directGrants: ["grant-a"] },
      tagPolicy: { requiredTags: ["catalog"] },
      circuitBreaker: { enabled: true },
      operations: [{
        operationKey: "list",
        method: "POST",
        path: "/rpc",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] }
        }
      }]
    };
    const references: any[] = [{
      type: "credential" as const,
      reference: "credential://vault/catalog",
      revision: 1,
      use: "request-auth"
    }];
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 6,
      services: [{
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 3,
        manifestDigest: "a".repeat(64),
        publication: publication(6)
      }]
    });
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 6,
      service: {
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 3,
        manifestDigest: "a".repeat(64),
        publication: publication(6),
        descriptor,
        references
      }
    });
    client.replaceUpstreamService.mockResolvedValue({
      ok: true, serviceId: "svc_fixture", state: "publishing", serviceRevision: 4, setRevision: 7,
      manifestDigest: "b".repeat(64), receiptRef: "urn:meshrix:receipt:replace",
      publication: publication(7, "b".repeat(64)), replayed: false
    });

    route.query = { serviceId: "svc_fixture" };
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.replaceUpstreamService).toHaveBeenCalledWith(
      "svc_fixture",
      { ...descriptor, references },
      3,
      6
    );
  });

  it("binds disable, republish, and remove controls to the selected revisions", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 8,
      services: [{
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 5,
        manifestDigest: "a".repeat(64),
        publication: publication(8)
      }]
    });
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 8,
      service: {
        serviceId: "svc_fixture",
        state: "publishing",
        serviceRevision: 5,
        manifestDigest: "a".repeat(64),
        publication: publication(8),
        descriptor: { serviceProtocol: "http", baseUrl: "https://service.invalid" },
        references: []
      }
    });
    client.disableUpstreamService.mockResolvedValue({ ok: true });
    client.republishUpstreamService.mockResolvedValue({ ok: true });
    client.removeUpstreamService.mockResolvedValue({ ok: true });
    registerConsoleConfirmHost();
    try {
      route.query = { serviceId: "svc_fixture" };
      const wrapper: any = mount(UpstreamServicePublishView);
      await flushPromises();
      const actions: any = wrapper.findAll(".form-actions button");
      // Disable and republish route through the REQ-010 destructive registry
      // confirm; the remove flow confirms through the same seam.
      await actions[2].trigger("click");
      await flushPromises();
      settleConsoleConfirm(true);
      await flushPromises();
      await actions[3].trigger("click");
      await flushPromises();
      settleConsoleConfirm(true);
      await flushPromises();
      await actions[4].trigger("click");
      await flushPromises();
      settleConsoleConfirm(true);
      await flushPromises();
      expect(client.disableUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
      expect(client.republishUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
      expect(client.removeUpstreamService).toHaveBeenCalledWith("svc_fixture", 5, 8);
    } finally {
      unregisterConsoleConfirmHost();
    }
  });
});
