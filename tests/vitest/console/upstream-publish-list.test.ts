// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, createWebHashHistory, type Router } from "vue-router";

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
const pageRefreshHandler: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));

import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
} from "../../../apps/console/composables/console-confirm-controller";

function publication(revision: number) : any {
  return {
    publicationRef: `urn:meshrix:upstream-publication:${revision}`,
    status: "server_published" as const,
    candidateRevision: revision,
    candidateDigest: "a".repeat(64),
  };
}

function summary(serviceId: string, revision: number = 1) : any {
  return {
    serviceId,
    state: "server_published" as const,
    serviceRevision: revision,
    manifestDigest: "a".repeat(64),
    publication: publication(revision),
  };
}

function detail(serviceId: string, revision: number = 1) : any {
  return {
    ok: true,
    setRevision: revision + 1,
    service: {
      ...summary(serviceId, revision),
      descriptor: {
        serviceProtocol: "http" as const,
        label: `Label of ${serviceId}`,
        baseUrl: "https://service.invalid:443",
        operations: [],
      },
      references: [],
    },
  };
}

async function mountView(initialPath: string = "/") : Promise<{ wrapper: any; router: Router }> {
  const router: Router = createRouter({
    history: createWebHashHistory(),
    routes: [{ path: "/", component: { render: () : any => null } }],
  });
  await router.push(initialPath);
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
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
});

describe("UpstreamServicePublishView published service list", () : any => {
  it("renders the list returned by listPublishedServices above the form", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 4,
      services: [summary("svc_inventory", 2), summary("svc_catalog", 3)],
    });
    const { wrapper } = await mountView("/");
    const msg: any = consoleMessages[currentConsoleLocale.value].publishList;

    expect(client.listPublishedServices).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll(".published-service-row")).toHaveLength(2);
    expect(wrapper.findAll(".published-service-id").map((node: any) : string => node.text())).toEqual([
      "svc_inventory",
      "svc_catalog",
    ]);
    expect(wrapper.text()).toContain(msg.title);
    // Available per-item summary: state and publication status.
    expect(wrapper.text()).toContain("server_published");
    expect(wrapper.text()).toContain("revision 2");
    expect(wrapper.text()).toContain("revision 3");
    wrapper.unmount();
  });

  it("enters the same edit state from a list click as from the ?serviceId= deep link", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 4,
      services: [summary("svc_inventory", 2)],
    });
    client.getPublishedService.mockResolvedValue(detail("svc_inventory", 2));

    const deepLink: any = await mountView("/?serviceId=svc_inventory");
    expect(client.getPublishedService).toHaveBeenCalledWith("svc_inventory");
    const deepLinkForm: Record<string, unknown> = { ...(deepLink.wrapper.vm as any).form };
    deepLink.wrapper.unmount();

    client.getPublishedService.mockClear();
    const clicked: any = await mountView("/");
    await clicked.wrapper.find(".published-service-select").trigger("click");
    await flushPromises();

    expect(client.getPublishedService).toHaveBeenCalledWith("svc_inventory");
    expect({ ...(clicked.wrapper.vm as any).form }).toEqual(deepLinkForm);
    expect((clicked.wrapper.find("#upstream-service-name").element as HTMLInputElement).value).toBe(
      "Label of svc_inventory",
    );
    expect((clicked.wrapper.vm as any).selectedServiceId).toBe("svc_inventory");
    expect((clicked.wrapper.vm as any).selectedServiceRevision).toBe(2);
    clicked.wrapper.unmount();
  });

  it("reflects the selection in the URL and keeps the deep link stable", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 4,
      services: [summary("svc_inventory", 2)],
    });
    client.getPublishedService.mockResolvedValue(detail("svc_inventory", 2));

    const clicked: any = await mountView("/");
    expect(clicked.router.currentRoute.value.query.serviceId).toBeUndefined();
    await clicked.wrapper.find(".published-service-select").trigger("click");
    await flushPromises();
    expect(clicked.router.currentRoute.value.query.serviceId).toBe("svc_inventory");
    clicked.wrapper.unmount();

    const linked: any = await mountView("/?serviceId=svc_inventory");
    await flushPromises();
    expect(linked.router.currentRoute.value.query.serviceId).toBe("svc_inventory");
    linked.wrapper.unmount();
  });

  it("falls back to the empty draft with keyed notice for a stale id", async () : Promise<any> => {
    client.getPublishedService.mockRejectedValue(new Error("service not found"));
    const { wrapper, router } = await mountView("/?serviceId=svc_ghost");
    const msg: any = consoleMessages[currentConsoleLocale.value].publishList;

    expect(wrapper.text()).toContain(msg.staleSelection);
    expect((wrapper.find("#upstream-service-name").element as HTMLInputElement).value).toBe("");
    expect((wrapper.vm as any).form.serviceProtocol).toBe("");
    expect((wrapper.vm as any).selectedServiceId).toBe("");
    expect(router.currentRoute.value.query.serviceId).toBeUndefined();
    wrapper.unmount();
  });

  it("renders the empty state with a create-first-service action scrolling to the form", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
    const { wrapper } = await mountView("/");
    const msg: any = consoleMessages[currentConsoleLocale.value].publishList;

    expect(wrapper.text()).toContain(msg.emptyTitle);
    expect(wrapper.text()).toContain(msg.emptyDescription);
    expect(wrapper.find("#upstream-publish-form").exists()).toBe(true);
    const action: any = wrapper.find(".console-empty-state-actions button");
    expect(action.text()).toBe(msg.emptyAction);

    // jsdom does not implement scrollIntoView; provide a stub to observe it.
    if (typeof Element.prototype.scrollIntoView !== "function") {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    const scrollSpy: any = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() : any => undefined);
    try {
      await action.trigger("click");
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
    wrapper.unmount();
  });

  it("routes disable through the destructive registry confirm and skips the call when declined", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 4,
      services: [summary("svc_inventory", 2)],
    });
    client.getPublishedService.mockResolvedValue(detail("svc_inventory", 2));
    client.disableUpstreamService.mockResolvedValue({ ok: true });
    registerConsoleConfirmHost();
    try {
      const { wrapper } = await mountView("/?serviceId=svc_inventory");
      const actions: any = wrapper.findAll(".form-actions button");

      await actions[2].trigger("click");
      await flushPromises();
      expect(client.disableUpstreamService).not.toHaveBeenCalled();
      settleConsoleConfirm(false);
      await flushPromises();
      expect(client.disableUpstreamService).not.toHaveBeenCalled();
      expect(wrapper.text()).not.toContain("Service disabled.");

      await actions[2].trigger("click");
      await flushPromises();
      settleConsoleConfirm(true);
      await flushPromises();
      expect(client.disableUpstreamService).toHaveBeenCalledWith("svc_inventory", 2, 3);
      expect(wrapper.text()).toContain("Service disabled.");
      wrapper.unmount();
    } finally {
      unregisterConsoleConfirmHost();
    }
  });

  it("routes republish through the destructive registry confirm when confirmed", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 4,
      services: [summary("svc_inventory", 2)],
    });
    client.getPublishedService.mockResolvedValue(detail("svc_inventory", 2));
    client.republishUpstreamService.mockResolvedValue({ ok: true });
    registerConsoleConfirmHost();
    try {
      const { wrapper } = await mountView("/?serviceId=svc_inventory");
      const actions: any = wrapper.findAll(".form-actions button");

      await actions[3].trigger("click");
      await flushPromises();
      expect(client.republishUpstreamService).not.toHaveBeenCalled();
      settleConsoleConfirm(true);
      await flushPromises();
      expect(client.republishUpstreamService).toHaveBeenCalledWith("svc_inventory", 2, 3);
      wrapper.unmount();
    } finally {
      unregisterConsoleConfirmHost();
    }
  });
});
