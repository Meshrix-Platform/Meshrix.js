// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, createWebHashHistory, type Router } from "vue-router";

const browserWindowMock: any = vi.hoisted(() : any => ({ failWrites: false }));
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

// The storage helpers delegate to the real jsdom localStorage so drafts stay
// inspectable; failWrites injects storage failures for the degrade path.
vi.mock("@meshrix/ui-console/browser-window", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("@meshrix/ui-console/browser-window")>(),
  readBrowserLocalStorageItem: (key: string) : any => window.localStorage.getItem(key),
  writeBrowserLocalStorageItem: (key: string, value: string) : any => {
    if (browserWindowMock.failWrites) return false;
    window.localStorage.setItem(key, value);
    return true;
  },
  removeBrowserLocalStorageItem: (key: string) : any => window.localStorage.removeItem(key),
}));
vi.mock("../../../apps/console/lib/upstream-service-publish-client", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal<typeof import("../../../apps/console/lib/upstream-service-publish-client")>(),
  ...client
}));
vi.mock("@meshrix/ui-console/page-refresh", async (importOriginal?: any) : Promise<any> => ({
  ...await importOriginal(),
  usePageRefreshHandler: pageRefreshHandler,
}));

import {
  PUBLISH_DRAFT_DEBOUNCE_MS,
  PUBLISH_DRAFT_SCHEMA_VERSION,
  PUBLISH_DRAFT_STORAGE_KEY,
  createPublishDraftAutosave,
  type PublishDraftAutosaveOptions,
} from "../../../apps/console/composables/console-publish-draft-autosave";
import UpstreamServicePublishView from "../../../apps/console/views/admin/UpstreamServicePublishView.vue";
import { consoleMessages, currentConsoleLocale } from "../../../apps/console/i18n/console";

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

const activeHarnesses: any[] = [];

function createHarness(overrides: Partial<PublishDraftAutosaveOptions> = {}) : any {
  const notices: Array<{ message: string; tone: string }> = [];
  const state: any = {
    currentKey: `${PUBLISH_DRAFT_STORAGE_KEY}:svc_a`,
    form: { serviceKey: "svc_a", label: "A" },
    dirty: false,
  };
  const autosave: any = createPublishDraftAutosave({
    draftKey: () : any => state.currentKey,
    serialize: () : any => ({ ...state.form }),
    restore: vi.fn(),
    isDirty: () : any => state.dirty,
    markClean: () : any => { state.dirty = false; },
    onNotice: (message: string, tone: string) : any => notices.push({ message, tone }),
    ...overrides,
  });
  activeHarnesses.push(autosave);
  return { autosave, state, notices };
}

beforeEach(() : any => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  browserWindowMock.failWrites = false;
  vi.clearAllMocks();
  pageRefreshHandler.mockClear();
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
});

describe("createPublishDraftAutosave", () : any => {
  beforeEach(() : any => {
    vi.useFakeTimers();
  });

  afterEach(() : any => {
    for (const autosave of activeHarnesses.splice(0)) {
      autosave.dispose();
    }
    vi.useRealTimers();
  });

  it("coalesces a burst of schedules into a single write after the debounce", async () : Promise<any> => {
    const { autosave, state, notices } = createHarness();
    state.dirty = true;
    autosave.scheduleSave();
    autosave.scheduleSave();
    autosave.scheduleSave();
    expect(window.localStorage.getItem(state.currentKey)).toBeNull();
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS - 1);
    expect(window.localStorage.getItem(state.currentKey)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    const payload: any = JSON.parse(window.localStorage.getItem(state.currentKey) as string);
    expect(payload.schemaVersion).toBe(PUBLISH_DRAFT_SCHEMA_VERSION);
    expect(payload.serviceId).toBe("svc_a");
    expect(payload.form).toEqual({ serviceKey: "svc_a", label: "A" });
    expect(notices.at(-1)?.tone).toBe("success");
    expect(notices.at(-1)?.message).toBe(consoleMessages[currentConsoleLocale.value].publishDraft.saved);
  });

  it("writes each service to its own slot and drops a stale write when the key moves", async () : Promise<any> => {
    const { autosave, state } = createHarness();
    state.dirty = true;
    autosave.scheduleSave();
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    expect(
      JSON.parse(window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_a`) as string).form.serviceKey,
    ).toBe("svc_a");

    state.currentKey = `${PUBLISH_DRAFT_STORAGE_KEY}:svc_b`;
    state.form = { serviceKey: "svc_b", label: "B" };
    state.dirty = true;
    autosave.scheduleSave();
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    expect(
      JSON.parse(window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_b`) as string).form.serviceKey,
    ).toBe("svc_b");

    // The context moved before the debounce fired: the captured write is dropped.
    state.currentKey = `${PUBLISH_DRAFT_STORAGE_KEY}:svc_c`;
    state.dirty = true;
    autosave.scheduleSave();
    state.currentKey = `${PUBLISH_DRAFT_STORAGE_KEY}:svc_d`;
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    expect(window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_c`)).toBeNull();
  });

  it("binds the beforeunload guard while dirty and releases it once clean", async () : Promise<any> => {
    const { autosave, state } = createHarness();

    // Clean schedule binds nothing.
    autosave.scheduleSave();
    const pristine: any = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);

    state.dirty = true;
    autosave.scheduleSave();
    const dirtyEvent: any = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    const cleanEvent: any = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("restores a keyed slot through the validation chain and marks clean", async () : Promise<any> => {
    const key = `${PUBLISH_DRAFT_STORAGE_KEY}:svc_a`;
    window.localStorage.setItem(key, JSON.stringify({
      schemaVersion: PUBLISH_DRAFT_SCHEMA_VERSION,
      serviceId: "svc_a",
      form: { serviceKey: "svc_a", label: "Restored label" },
    }));
    const restore: any = vi.fn();
    const { autosave, state } = createHarness({ restore });
    state.dirty = true;

    const ok: any = await autosave.restoreFor(key);
    expect(ok).toBe(true);
    expect(restore).toHaveBeenCalledWith({ serviceKey: "svc_a", label: "Restored label" });
    expect(state.dirty).toBe(false);
  });

  it("rejects a poisoned payload through the validation chain", async () : Promise<any> => {
    const key = `${PUBLISH_DRAFT_STORAGE_KEY}:svc_a`;
    // JSON.parse materializes an own "__proto__" key that object literals cannot.
    window.localStorage.setItem(key, JSON.stringify(JSON.parse(
      `{"schemaVersion":"${PUBLISH_DRAFT_SCHEMA_VERSION}","serviceId":"svc_a",` +
      `"form":{"serviceKey":{"__proto__":{"polluted":true}}}}`,
    )));
    const { autosave } = createHarness();
    await expect(autosave.restoreFor(key)).rejects.toThrow(/invalid format/);
  });

  it("degrades to manual-save-only with a keyed notice on storage failure", async () : Promise<any> => {
    const { autosave, state, notices } = createHarness();
    const messages: any = consoleMessages[currentConsoleLocale.value].publishDraft;
    state.dirty = true;
    browserWindowMock.failWrites = true;

    autosave.scheduleSave();
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    expect(window.localStorage.getItem(state.currentKey)).toBeNull();
    expect(notices.at(-1)?.tone).toBe("danger");
    expect(notices.at(-1)?.message).toBe(messages.storageFailure);

    // Autosave is disabled after degradation: further schedules do not write.
    autosave.scheduleSave();
    await vi.advanceTimersByTimeAsync(PUBLISH_DRAFT_DEBOUNCE_MS);
    expect(window.localStorage.getItem(state.currentKey)).toBeNull();

    // The manual path still attempts the write and surfaces the failure.
    autosave.saveNow();
    expect(window.localStorage.getItem(state.currentKey)).toBeNull();
    expect(notices.at(-1)?.tone).toBe("danger");
  });
});

describe("UpstreamServicePublishView per-service draft autosave", () : any => {
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
    client.listPublishedServices.mockResolvedValue({ ok: true, setRevision: 0, services: [] });
    client.getPublishedService.mockResolvedValue(detail("svc_inventory"));
  });

  it("migrates the legacy single slot into the per-service slot on mount", async () : Promise<any> => {
    client.getPublishedService.mockResolvedValue(detail("svc_inventory"));
    window.localStorage.setItem(PUBLISH_DRAFT_STORAGE_KEY, JSON.stringify({
      schemaVersion: PUBLISH_DRAFT_SCHEMA_VERSION,
      serviceId: "svc_inventory",
      form: { label: "Legacy label", serviceProtocol: "http" },
    }));

    const { wrapper } = await mountView("/?serviceId=svc_inventory");

    expect((wrapper.find("#upstream-service-name").element as HTMLInputElement).value).toBe("Legacy label");
    expect(wrapper.text()).toContain(consoleMessages[currentConsoleLocale.value].publishDraft.restored);
    expect(window.localStorage.getItem(PUBLISH_DRAFT_STORAGE_KEY)).toBeNull();
    const migrated: any = JSON.parse(
      window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_inventory`) as string,
    );
    expect(migrated.form.label).toBe("Legacy label");
    wrapper.unmount();
  });

  it("migrates a legacy new-draft into the stable new: slot", async () : Promise<any> => {
    window.localStorage.setItem(PUBLISH_DRAFT_STORAGE_KEY, JSON.stringify({
      schemaVersion: PUBLISH_DRAFT_SCHEMA_VERSION,
      serviceId: "",
      form: { serviceKey: "legacy-new", label: "Legacy new" },
    }));

    const { wrapper } = await mountView("/");

    expect((wrapper.find("#upstream-service-key").element as HTMLInputElement).value).toBe("legacy-new");
    expect(window.localStorage.getItem(PUBLISH_DRAFT_STORAGE_KEY)).toBeNull();
    const newSlotKey: string | undefined = Object.keys(window.localStorage)
      .find((key: string) : any => key.startsWith(`${PUBLISH_DRAFT_STORAGE_KEY}:new:`));
    expect(newSlotKey).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(newSlotKey as string) as string).form.serviceKey).toBe("legacy-new");
    wrapper.unmount();
  });

  it("clears a poisoned slot and reports during restore", async () : Promise<any> => {
    window.localStorage.setItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_inventory`, JSON.stringify(JSON.parse(
      `{"schemaVersion":"${PUBLISH_DRAFT_SCHEMA_VERSION}","serviceId":"svc_inventory",` +
      `"form":{"label":{"__proto__":{"polluted":true}}}}`,
    )));

    const { wrapper } = await mountView("/?serviceId=svc_inventory");

    expect(wrapper.text()).toContain("invalid format");
    expect(window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_inventory`)).toBeNull();
    wrapper.unmount();
  });

  it("serializes credential references only — never plaintext secret keys", async () : Promise<any> => {
    client.getPublishedService.mockResolvedValue({
      ok: true,
      setRevision: 1,
      service: {
        ...summary("svc_inventory", 1),
        descriptor: {
          serviceProtocol: "http",
          baseUrl: "https://service.invalid:443",
          label: "Secure",
          operations: [],
          apiKey: "sk-plaintext-123",
          token: "tok-plaintext",
        },
        references: [{ type: "credential", reference: "credential://vault/catalog", revision: 1, use: "request-auth" }],
      },
    });

    const { wrapper } = await mountView("/?serviceId=svc_inventory");
    await wrapper.findAll(".form-actions button")[0].trigger("click");
    await flushPromises();

    const payload: any = JSON.parse(
      window.localStorage.getItem(`${PUBLISH_DRAFT_STORAGE_KEY}:svc_inventory`) as string,
    );
    const keys: string = Object.keys(payload.form).join(",");
    expect(keys).not.toMatch(/secret|token|password|api[_-]?key|credentialValue/i);
    expect(payload.form.references).toEqual([
      { type: "credential", reference: "credential://vault/catalog", revision: 1, use: "request-auth" },
    ]);
    wrapper.unmount();
  });

  it("keeps per-service drafts separate across reloads without cross-write", async () : Promise<any> => {
    client.listPublishedServices.mockResolvedValue({
      ok: true,
      setRevision: 0,
      services: [summary("svc_a", 1), summary("svc_b", 1)],
    });
    client.getPublishedService.mockImplementation((serviceId: string) : any => Promise.resolve(detail(serviceId, 1)));

    const first: any = await mountView("/?serviceId=svc_a");
    await first.wrapper.find("#upstream-service-name").setValue("Draft for A");
    await first.wrapper.findAll(".form-actions button")[0].trigger("click");
    await flushPromises();
    first.wrapper.unmount();

    const second: any = await mountView("/?serviceId=svc_b");
    await second.wrapper.find("#upstream-service-name").setValue("Draft for B");
    await second.wrapper.findAll(".form-actions button")[0].trigger("click");
    await flushPromises();
    second.wrapper.unmount();

    const reloadA: any = await mountView("/?serviceId=svc_a");
    expect((reloadA.wrapper.find("#upstream-service-name").element as HTMLInputElement).value).toBe("Draft for A");
    reloadA.wrapper.unmount();

    const reloadB: any = await mountView("/?serviceId=svc_b");
    expect((reloadB.wrapper.find("#upstream-service-name").element as HTMLInputElement).value).toBe("Draft for B");
    reloadB.wrapper.unmount();
  });
});
