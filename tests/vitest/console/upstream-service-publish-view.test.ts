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
  observeUpstreamServicePublication: vi.fn(),
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
import { UpstreamPublicationObservationError } from "../../../apps/console/lib/upstream-service-publish-client";
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

function publishedDetail(serviceId: string, serviceRevision: number) : any {
  return {
    ok: true,
    setRevision: serviceRevision + 1,
    service: {
      serviceId,
      state: "server_published",
      serviceRevision,
      manifestDigest: "a".repeat(64),
      publication: { ...publication(serviceRevision + 1), status: "server_published" },
    },
  };
}

function deferred<T>() : { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise: Promise<T> = new Promise<T>((res, rej) : void => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function publishInventory(wrapper: any) : Promise<any> {
  await wrapper.find('#upstream-service-key').setValue("inventory");
  await wrapper.find('#upstream-service-protocol').setValue("http");
  await wrapper.find(".form-actions .primary").trigger("click");
  await flushPromises();
}

function portableMcpDocument(): Record<string, any> {
  return {
    kind: "meshrix.upstream-service",
    schemaVersion: "v0.0.1:upstream-service:portable-import-2",
    serviceKey: "inventory-mcp",
    descriptor: {
      serviceProtocol: "mcp",
      mcp: {
        transport: "http",
        url: "https://service.invalid/mcp",
        protocolVersion: "2026-07-28",
      },
    },
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
  client.observeUpstreamServicePublication.mockResolvedValue({
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
    expect(wrapper.find('option[value="mcp"]').exists()).toBe(true);

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
    expect(client.observeUpstreamServicePublication).toHaveBeenCalledWith(
      { serviceId: "svc_fixture", serviceRevision: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    expect(window.localStorage.length).toBe(0);
    expect(wrapper.text()).toContain('"status": "healthy"');
  });

  it("publishes an explicitly entered modern remote MCP descriptor without HTTP operation fields", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find('#upstream-service-key').setValue("inventory-mcp");
    await wrapper.find('#upstream-service-protocol').setValue("mcp");
    await wrapper.find('#upstream-mcp-transport').setValue("http");
    await wrapper.find('#upstream-mcp-url').setValue("https://service.invalid/mcp");
    await wrapper.find('#upstream-mcp-protocol-version').setValue("2026-07-28");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory-mcp", {
      serviceProtocol: "mcp",
      references: [],
      mcp: {
        transport: "http",
        url: "https://service.invalid/mcp",
        protocolVersion: "2026-07-28",
      },
    }, 0);
    expect(client.observeUpstreamServicePublication).toHaveBeenCalledWith(
      { serviceId: "svc_fixture", serviceRevision: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    wrapper.unmount();
  });

  it("publishes MCP after clearing errors from an invalid HTTP tool path", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();

    await wrapper.find('#upstream-service-key').setValue("inventory-mcp");
    await wrapper.find('#upstream-service-protocol').setValue("http");
    const operationsTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Tool paths");
    await operationsTab!.trigger("click");
    await wrapper.find(".operation-builder .table-action").trigger("click");
    expect(wrapper.text()).toContain("Complete all required tool path fields.");

    const basicTab: any = wrapper.findAll('[role="tab"]').find((tab?: any) : any => tab.text() === "Service information");
    await basicTab!.trigger("click");
    await wrapper.find('#upstream-service-protocol').setValue("mcp");
    expect(wrapper.findAll('[role="tab"]').some((tab: any) => tab.text() === "Tool paths")).toBe(false);
    await wrapper.find('#upstream-mcp-transport').setValue("http");
    await wrapper.find('#upstream-mcp-url').setValue("https://service.invalid/mcp");
    await wrapper.find('#upstream-mcp-protocol-version').setValue("2026-07-28");
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory-mcp", {
      serviceProtocol: "mcp",
      references: [],
      mcp: {
        transport: "http",
        url: "https://service.invalid/mcp",
        protocolVersion: "2026-07-28",
      },
    }, 0);
    wrapper.unmount();
  });

  it("requires explicit local-network consent and retains it through browser draft restore", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await wrapper.find('#upstream-service-key').setValue("private-inventory");
    await wrapper.find('#upstream-service-protocol').setValue("mcp");
    await wrapper.find('#upstream-mcp-transport').setValue("http");
    await wrapper.find('#upstream-mcp-url').setValue("http://127.0.0.1:8080/mcp");
    await wrapper.find('#upstream-mcp-protocol-version').setValue("2026-07-28");
    const permission = wrapper.find('[role="switch"]');
    expect(permission.attributes('aria-checked')).toBe("false");
    expect(permission.attributes('aria-describedby')).toBe("upstream-local-network-help");
    await permission.trigger("click");
    const save = wrapper.findAll('.form-actions button').find((button: any) => button.text() === "Save");
    await save.trigger("click");
    wrapper.unmount();

    const restored: any = mount(UpstreamServicePublishView);
    await flushPromises();
    expect(restored.find('[role="switch"]').attributes('aria-checked')).toBe("true");
    await restored.find('.form-actions .primary').trigger("click");
    await flushPromises();
    expect(client.createUpstreamService.mock.calls[0][1]).toMatchObject({
      allowLocalNetwork: true,
      mcp: { url: "http://127.0.0.1:8080/mcp", protocolVersion: "2026-07-28" },
    });
    restored.unmount();
  });

  it("loads an existing local-network permission and can explicitly revoke it on replacement", async () : Promise<any> => {
    route.query = { serviceId: "svc_fixture" };
    client.getPublishedService.mockResolvedValue({
      ok: true, setRevision: 3,
      service: {
        serviceId: "svc_fixture", state: "server_published", serviceRevision: 2,
        descriptor: { ...portableMcpDocument().descriptor, allowLocalNetwork: true }, references: [],
      },
    });
    client.replaceUpstreamService.mockResolvedValue({
      ok: true, serviceId: "svc_fixture", serviceRevision: 3, setRevision: 4, publication: publication(4),
    });
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe("true");
    await wrapper.find('[role="switch"]').trigger("click");
    await wrapper.find('.form-actions .primary').trigger("click");
    await flushPromises();
    expect(client.replaceUpstreamService).toHaveBeenCalledWith("svc_fixture", expect.objectContaining({ allowLocalNetwork: false }), 2, 3);
    wrapper.unmount();
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

  it("orders external connection fields before Meshrix.js metadata and explains the service identifier", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const fieldLabels: string[] = wrapper.findAll('.tab-content > .form-field').map((field: any) : string =>
      field.find("label, span").text()
    );
    expect(fieldLabels).toEqual([
      "Protocol",
      "Service URL *",
      consoleMessages[currentConsoleLocale.value].publishForm.localNetworkLabel,
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
        baseUrl: "https://service.invalid",
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

  it("imports and submits the canonical modern MCP HTTP descriptor through the same publish flow", async () : Promise<any> => {
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    const importer: any = wrapper.findComponent({ name: "PortableServiceImportPanel" });
    await importer.find("textarea").setValue(JSON.stringify(portableMcpDocument()));
    await importer.find('[data-action="validate-service-json"]').trigger("click");
    await importer.find('[data-action="load-service-draft"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('#upstream-service-protocol').element).toHaveProperty("value", "mcp");
    expect(wrapper.find('#upstream-mcp-transport').element).toHaveProperty("value", "http");
    expect(wrapper.find('#upstream-mcp-url').element).toHaveProperty("value", "https://service.invalid/mcp");
    expect(wrapper.find('#upstream-mcp-protocol-version').element).toHaveProperty("value", "2026-07-28");
    expect(wrapper.findAll('[role="tab"]').some((tab: any) => tab.text() === "Tool paths")).toBe(false);
    await wrapper.find(".form-actions .primary").trigger("click");
    await flushPromises();

    expect(client.createUpstreamService).toHaveBeenCalledWith("inventory-mcp", {
      serviceProtocol: "mcp",
      mcp: {
        transport: "http",
        url: "https://service.invalid/mcp",
        protocolVersion: "2026-07-28",
      },
      references: [],
    }, 0);
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
        baseUrl: "https://service.invalid",
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
      baseUrl: "https://service.invalid",
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
    expect(client.observeUpstreamServicePublication).toHaveBeenCalledWith(
      { serviceId: "svc_fixture", serviceRevision: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

  it("accepts a canonical modern MCP HTTP import without top-level baseUrl or operations", () : any => {
    const document = portableMcpDocument();
    document.descriptor = {
      ...document.descriptor,
      allowLocalNetwork: false,
      permissions: { requiredScopes: ["catalog:read"] },
      audience: { organizations: ["org-example"] },
      references: [{
        type: "credential",
        reference: "secret://vault/catalog",
        revision: 4,
        use: "request-auth",
        host: "service.example",
        protocol: "https",
      }],
      mcp: {
        ...document.descriptor.mcp,
        headers: { "x-valorius-project": "example-context" },
      },
    };
    expect(parsePortableUpstreamServiceImport(JSON.stringify(document))).toMatchObject({
      serviceKey: "inventory-mcp",
      descriptor: {
        serviceProtocol: "mcp",
        allowLocalNetwork: false,
        permissions: { requiredScopes: ["catalog:read"] },
        audience: { organizations: ["org-example"] },
        references: [{
          type: "credential",
          reference: "secret://vault/catalog",
          revision: 4,
          use: "request-auth",
        }],
        mcp: {
          transport: "http",
          url: "https://service.invalid/mcp",
          protocolVersion: "2026-07-28",
          headers: { "x-valorius-project": "example-context" },
        },
      },
    });
  });

  it("rejects unsupported MCP transport/version, routing fields, unsafe URLs and inline credentials", () : any => {
    const mutations: Array<(document: Record<string, any>) => void> = [
      (document) => { document.descriptor.mcp.transport = "stdio"; },
      (document) => { document.descriptor.mcp.protocolVersion = "2027-01-01"; },
      (document) => { document.descriptor.mcp.command = "run"; },
      (document) => { document.descriptor.mcp.url = "https://service.invalid:65536/mcp"; },
      (document) => { document.descriptor.mcp.url = `https://${["fixture", "placeholder"].join(":")}@service.invalid/mcp`; },
      (document) => { document.descriptor.operations = []; },
      (document) => { document.descriptor.risk = "safe_write"; },
      (document) => { document.descriptor.mcp.headers = { authorization: "Bearer redacted-placeholder-value" }; },
      (document) => { document.descriptor.mcp.headers = { "x-context": "Bearer redacted-placeholder-value" }; },
      (document) => { document.descriptor.references = [{ type: "credential", value: "inline" }]; },
    ];
    for (const mutate of mutations) {
      const document = portableMcpDocument();
      mutate(document);
      expect(() => parsePortableUpstreamServiceImport(JSON.stringify(document))).toThrow();
    }
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

    expect(wrapper.text()).toContain(
      consoleMessages[currentConsoleLocale.value].publishOutcome.healthNotPassed,
    );
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
    client.republishUpstreamService.mockResolvedValue({
      ok: true, serviceId: "svc_fixture", state: "publishing", serviceRevision: 6, setRevision: 9,
      manifestDigest: "b".repeat(64), receiptRef: "urn:meshrix:receipt:republish",
      publication: publication(9, "b".repeat(64)), replayed: false,
    });
    client.observeUpstreamServicePublication.mockResolvedValue({
      ok: true, setRevision: 9,
      service: {
        serviceId: "svc_fixture", serviceRevision: 6, state: "server_published",
        manifestDigest: "b".repeat(64),
        publication: { ...publication(9, "b".repeat(64)), status: "server_published" },
      },
    });
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
      // The accepted republish advances the retained service revision before
      // the observation settles; the list refresh supplies the set revision.
      expect(client.removeUpstreamService).toHaveBeenCalledWith("svc_fixture", 6, 8);
    } finally {
      unregisterConsoleConfirmHost();
    }
  });
});

describe("UpstreamServicePublishView accepted-publication observation", () : any => {
  it("keeps a slow accepted publication in progress without a failed stage or duplicate mutation", async () : Promise<any> => {
    const pending: any = deferred<any>();
    client.observeUpstreamServicePublication.mockReturnValue(pending.promise);
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await publishInventory(wrapper);

    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);
    const [target, options]: any[] = client.observeUpstreamServicePublication.mock.calls[0];
    expect(target).toEqual({ serviceId: "svc_fixture", serviceRevision: 1 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);

    // The observation may last arbitrarily long: the gateway-publication stage
    // stays active and no failure is fabricated.
    expect(wrapper.findAll(".publish-stage").map((stage: any) : string[] => stage.classes())).toEqual([
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--active"],
      ["publish-stage", "publish-stage--pending"],
    ]);
    expect(wrapper.find(".publish-stage--failed").exists()).toBe(false);
    expect(wrapper.find(".upstream-publish-layout > .console-inline-alert.tone-danger").exists()).toBe(false);
    const messages: any = consoleMessages[currentConsoleLocale.value].publishOutcome;
    expect(wrapper.find('[data-testid="publication-observer"]').text()).toContain(messages.observationWaiting);
    expect((wrapper.find(".form-actions .primary").element as HTMLButtonElement).disabled).toBe(true);

    pending.resolve(publishedDetail("svc_fixture", 1));
    await flushPromises();
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="publication-observer"]').exists()).toBe(false);
    expect(wrapper.findAll(".publish-stage").map((stage: any) : string[] => stage.classes())).toEqual([
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--done"],
    ]);
    wrapper.unmount();
  });

  it("interrupts observation on a status failure and resumes against the retained acceptance", async () : Promise<any> => {
    client.observeUpstreamServicePublication
      .mockRejectedValueOnce(new UpstreamPublicationObservationError("interrupted", {
        serviceId: "svc_fixture", observedRevision: 1, message: "network unavailable",
      }))
      .mockResolvedValueOnce(publishedDetail("svc_fixture", 1));
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await publishInventory(wrapper);

    const messages: any = consoleMessages[currentConsoleLocale.value].publishOutcome;
    const observer: any = wrapper.find('[data-testid="publication-observer"]');
    expect(observer.text()).toContain(messages.observationInterrupted);
    expect(observer.find('[data-testid="publication-observer-resume"]').exists()).toBe(true);
    expect(wrapper.find(".publish-stage--failed").exists()).toBe(false);
    expect(wrapper.findAll(".publish-stage")[1].classes()).toContain("publish-stage--active");
    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);

    await observer.find('[data-testid="publication-observer-resume"]').trigger("click");
    await flushPromises();
    expect(client.observeUpstreamServicePublication).toHaveBeenCalledTimes(2);
    expect(client.observeUpstreamServicePublication.mock.calls[1][0]).toEqual({
      serviceId: "svc_fixture", serviceRevision: 1,
    });
    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    expect(wrapper.find('[data-testid="publication-observer"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("stops observation explicitly, disposes the request, and resumes from the retained acceptance", async () : Promise<any> => {
    const observations: any[] = [];
    client.observeUpstreamServicePublication.mockImplementation((_target: any, options: any) : Promise<any> => {
      const entry: any = { signal: options.signal, deferred: deferred<any>() };
      observations.push(entry);
      options.signal.addEventListener("abort", () : any => entry.deferred.reject(options.signal.reason), { once: true });
      return entry.deferred.promise;
    });
    const wrapper: any = mount(UpstreamServicePublishView, { attachTo: document.body });
    await flushPromises();
    await publishInventory(wrapper);

    const stop: any = wrapper.find('[data-testid="publication-observer-stop"]');
    expect(stop.exists()).toBe(true);
    stop.element.focus();
    await stop.trigger("click");
    await flushPromises();

    expect(observations[0].signal.aborted).toBe(true);
    const messages: any = consoleMessages[currentConsoleLocale.value].publishOutcome;
    expect(wrapper.find('[data-testid="publication-observer"]').text()).toContain(messages.observationStopped);
    const resume: any = wrapper.find('[data-testid="publication-observer-resume"]');
    expect(resume.exists()).toBe(true);
    expect(document.activeElement).toBe(resume.element);
    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);

    await resume.trigger("click");
    await flushPromises();
    expect(observations).toHaveLength(2);
    expect(observations[1].signal.aborted).toBe(false);
    expect(client.createUpstreamService).toHaveBeenCalledTimes(1);
    observations[1].deferred.resolve(publishedDetail("svc_fixture", 1));
    await flushPromises();
    expect(client.checkUpstreamServiceRuntimeHealth).toHaveBeenCalledWith("svc_fixture");
    wrapper.unmount();
  });

  it("disposes the observed publication on selection change and ignores its stale completion", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 8,
      services: [
        {
          serviceId: "svc_fixture", state: "publishing", serviceRevision: 1,
          manifestDigest: "a".repeat(64), publication: publication(1),
        },
        {
          serviceId: "svc_other", state: "server_published", serviceRevision: 2,
          manifestDigest: "a".repeat(64), publication: { ...publication(2), status: "server_published" },
        },
      ],
    });
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 8,
      service: {
        serviceId: "svc_other", state: "server_published", serviceRevision: 2,
        manifestDigest: "a".repeat(64),
        publication: { ...publication(2), status: "server_published" },
        descriptor: { serviceProtocol: "http", baseUrl: "https://service.invalid" },
        references: [],
      },
    });
    const pending: any = deferred<any>();
    client.observeUpstreamServicePublication.mockReturnValue(pending.promise);
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await publishInventory(wrapper);

    const staleSignal: AbortSignal = client.observeUpstreamServicePublication.mock.calls[0][1].signal;
    expect(staleSignal.aborted).toBe(false);

    const rows: any[] = wrapper.findAll(".published-service-select");
    expect(rows).toHaveLength(2);
    await rows[1].trigger("click");
    await flushPromises();

    expect(staleSignal.aborted).toBe(true);
    expect(wrapper.find('[data-testid="publication-observer"]').exists()).toBe(false);
    expect(wrapper.findAll(".publish-stage")).toHaveLength(0);

    pending.resolve(publishedDetail("svc_fixture", 1));
    await flushPromises();
    expect(client.checkUpstreamServiceRuntimeHealth).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("disposes the owned observer on unmount without asserting a server outcome", async () : Promise<any> => {
    const pending: any = deferred<any>();
    client.observeUpstreamServicePublication.mockReturnValue(pending.promise);
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await publishInventory(wrapper);
    const signal: AbortSignal = client.observeUpstreamServicePublication.mock.calls[0][1].signal;

    wrapper.unmount();
    expect(signal.aborted).toBe(true);

    pending.resolve(publishedDetail("svc_fixture", 1));
    await flushPromises();
    expect(client.checkUpstreamServiceRuntimeHealth).not.toHaveBeenCalled();
  });

  it("projects an authoritative superseded revision as a failed publication stage, distinct from interruption", async () : Promise<any> => {
    client.observeUpstreamServicePublication.mockRejectedValue(new UpstreamPublicationObservationError("superseded", {
      serviceId: "svc_fixture", observedRevision: 1, currentRevision: 2, message: "superseded",
    }));
    const wrapper: any = mount(UpstreamServicePublishView);
    await flushPromises();
    await publishInventory(wrapper);

    const messages: any = consoleMessages[currentConsoleLocale.value].publishOutcome;
    expect(wrapper.find('[data-testid="publication-observer"]').exists()).toBe(false);
    expect(wrapper.findAll(".publish-stage").map((stage: any) : string[] => stage.classes())).toEqual([
      ["publish-stage", "publish-stage--done"],
      ["publish-stage", "publish-stage--failed"],
      ["publish-stage", "publish-stage--pending"],
    ]);
    expect(wrapper.text()).toContain(messages.publicationSuperseded);
    expect(client.checkUpstreamServiceRuntimeHealth).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
