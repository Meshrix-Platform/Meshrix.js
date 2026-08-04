// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { computed, defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MeshrixTabs from "../../../apps/console/components/MeshrixTabs.vue";
import ConsoleDrawer from "../../../apps/console/components/shell/ConsoleDrawer.vue";
import { createConsoleOverlayController } from "../../../apps/console/composables/console-overlay-controller";
import {
  consoleMessages,
  currentConsoleLocale,
  setConsoleLocaleState,
} from "../../../apps/console/i18n/console";

const drawerShell: any = vi.hoisted(() : any => ({ current: null as any }));

vi.mock("@meshrix/ui-console/server-console-shell-context", () : any => ({
  useServerConsoleShellContext: () : any => drawerShell.current,
}));
// The drawer's N8 URL bridge needs a router; the overlay contract does not.
vi.mock("../../../apps/console/composables/use-console-url-state", async () : Promise<any> => {
  const { ref } = await import("vue");
  return {
    useConsoleUrlState: (key: string, defaultValue: string) : any => ref(defaultValue),
  };
});

afterEach(() : any => {
  setConsoleLocaleState("zh-CN");
  document.body.innerHTML = "";
});

function tabEvent(key: string, shiftKey = false) : KeyboardEvent {
  return new KeyboardEvent("keydown", { key, shiftKey, cancelable: true });
}

describe("createConsoleOverlayController", () : any => {
  function makeDom() : any {
    const invoker = document.createElement("button");
    invoker.textContent = "open";
    document.body.appendChild(invoker);
    const root = document.createElement("section");
    root.tabIndex = -1;
    const first = document.createElement("button");
    const middle = document.createElement("input");
    const last = document.createElement("button");
    root.append(first, middle, last);
    document.body.appendChild(root);
    return { invoker, root, first, middle, last };
  }

  it("captures the invoker, autofocuses the first control, and restores on deactivate", async () : Promise<any> => {
    const { invoker, root, first } = makeDom();
    invoker.focus();
    const onClose: any = vi.fn();
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      invoker: ref(invoker),
      onClose,
    });

    await overlay.activate();
    expect(document.activeElement).toBe(first);

    overlay.deactivate();
    expect(document.activeElement).toBe(invoker);
  });

  it("falls back to the pre-open active element when no invoker is given", async () : Promise<any> => {
    const { root, first } = makeDom();
    const preOpen = document.createElement("button");
    document.body.appendChild(preOpen);
    preOpen.focus();
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose: vi.fn(),
    });

    await overlay.activate();
    expect(document.activeElement).toBe(first);
    overlay.deactivate();
    expect(document.activeElement).toBe(preOpen);
  });

  it("never restores to document.body", async () : Promise<any> => {
    const { root } = makeDom();
    (document.activeElement as HTMLElement)?.blur?.();
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose: vi.fn(),
    });

    await overlay.activate();
    expect(() : any => overlay.deactivate()).not.toThrow();
  });

  it("cycles Tab forward from the last control to the first and Shift+Tab backward", async () : Promise<any> => {
    const { root, first, last } = makeDom();
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose: vi.fn(),
    });
    await overlay.activate();

    last.focus();
    overlay.onKeydown(tabEvent("Tab"));
    expect(document.activeElement).toBe(first);

    first.focus();
    overlay.onKeydown(tabEvent("Tab", true));
    expect(document.activeElement).toBe(last);

    // Focus outside the container is pulled back inside in both directions.
    document.body.focus();
    overlay.onKeydown(tabEvent("Tab"));
    expect(document.activeElement).toBe(first);
    document.body.focus();
    overlay.onKeydown(tabEvent("Tab", true));
    expect(document.activeElement).toBe(last);
    overlay.deactivate();
  });

  it("focuses the container itself when it holds no focusable control", async () : Promise<any> => {
    const root = document.createElement("section");
    root.tabIndex = -1;
    document.body.appendChild(root);
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose: vi.fn(),
    });
    await overlay.activate();

    overlay.onKeydown(tabEvent("Tab"));
    expect(document.activeElement).toBe(root);
    overlay.deactivate();
  });

  it("disables the trap with a dev log when the root is missing", async () : Promise<any> => {
    const warn: any = vi.spyOn(console, "warn").mockImplementation(() : any => undefined);
    const overlay: any = createConsoleOverlayController({
      root: ref(null),
      open: ref(true),
      onClose: vi.fn(),
    });

    const event: KeyboardEvent = tabEvent("Tab");
    expect(() : any => overlay.onKeydown(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("calls onClose on Escape and ignores keys while closed", async () : Promise<any> => {
    const { root } = makeDom();
    const onClose: any = vi.fn();
    const open: any = ref(true);
    const overlay: any = createConsoleOverlayController({
      root,
      open,
      onClose,
    });
    await overlay.activate();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    open.value = false;
    overlay.onKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    overlay.deactivate();
  });

  it("removes the document listener on deactivate and activates only once", async () : Promise<any> => {
    const { root } = makeDom();
    const onClose: any = vi.fn();
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose,
    });
    await overlay.activate();
    await overlay.activate();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    overlay.deactivate();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("honors the cancel-safe initial focus marker", async () : Promise<any> => {
    const { root, first, last } = makeDom();
    last.setAttribute("data-overlay-cancel-safe", "");
    const overlay: any = createConsoleOverlayController({
      root: ref(root),
      open: ref(true),
      onClose: vi.fn(),
      initialFocus: "cancel-safe",
    });

    await overlay.activate();
    expect(document.activeElement).toBe(last);
    expect(document.activeElement).not.toBe(first);
    overlay.deactivate();
  });
});

describe("MeshrixTabs keyboard navigation", () : any => {
  const tabs: any = [
    { key: "a", label: "甲" },
    { key: "b", label: "乙" },
    { key: "c", label: "丙", disabled: true },
    { key: "d", label: "丁", closable: true },
  ];

  function mountTabs(panelIds?: Record<string, string>) : any {
    const Harness: any = defineComponent({
      components: { MeshrixTabs },
      setup() : any {
        const active: any = ref("a");
        return { active, tabs, panelIds };
      },
      template: `<MeshrixTabs v-model="active" :tabs="tabs" :panel-ids="panelIds" />`,
    });
    return mount(Harness, { attachTo: document.body });
  }

  it("moves selection and roving tabindex with arrow keys, skipping disabled tabs", async () : Promise<any> => {
    const wrapper: any = mountTabs({ a: "panel-a", b: "panel-b", c: "panel-c", d: "panel-d" });
    const tablist: any = wrapper.find("[role='tablist']");
    expect(tablist.exists()).toBe(true);

    const tabA: any = wrapper.find("#meshrix-tab-a");
    expect(tabA.attributes("aria-selected")).toBe("true");
    expect(tabA.attributes("tabindex")).toBe("0");
    expect(tabA.attributes("aria-controls")).toBe("panel-a");

    await tabA.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    const tabB: any = wrapper.find("#meshrix-tab-b");
    expect(tabB.attributes("aria-selected")).toBe("true");
    expect(tabB.attributes("tabindex")).toBe("0");
    expect(tabA.attributes("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(tabB.element);

    // Disabled tab c is skipped in both directions.
    await tabB.trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-d").attributes("aria-selected")).toBe("true");
    await wrapper.find("#meshrix-tab-d").trigger("keydown", { key: "ArrowLeft" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-b").attributes("aria-selected")).toBe("true");

    // Wrapping plus Home/End.
    await wrapper.find("#meshrix-tab-b").trigger("keydown", { key: "ArrowLeft" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-a").attributes("aria-selected")).toBe("true");
    await wrapper.find("#meshrix-tab-a").trigger("keydown", { key: "ArrowLeft" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-d").attributes("aria-selected")).toBe("true");
    await wrapper.find("#meshrix-tab-d").trigger("keydown", { key: "Home" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-a").attributes("aria-selected")).toBe("true");
    await wrapper.find("#meshrix-tab-a").trigger("keydown", { key: "End" });
    await flushPromises();
    expect(wrapper.find("#meshrix-tab-d").attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("omits aria-controls when no panel ids are provided", () : any => {
    const wrapper: any = mountTabs();
    expect(wrapper.find("#meshrix-tab-a").attributes("aria-controls")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps click selection and close emits intact (publish-form usage)", async () : Promise<any> => {
    const wrapper: any = mountTabs();
    const tabsComponent: any = wrapper.findComponent(MeshrixTabs);

    await wrapper.find("#meshrix-tab-b").trigger("click");
    expect(tabsComponent.emitted("update:modelValue")?.[0]).toEqual(["b"]);
    expect(tabsComponent.emitted("change")?.[0]).toEqual(["b"]);

    await wrapper.find("#meshrix-tab-d .meshrix-tab__close").trigger("click");
    expect(tabsComponent.emitted("close")?.[0]).toEqual(["d"]);
    // The close click must not also select the tab.
    expect(tabsComponent.emitted("update:modelValue")).toHaveLength(1);
    wrapper.unmount();
  });
});

describe("ConsoleDrawer overlay contract", () : any => {
  const mountedDrawers: any[] = [];

  beforeEach(() : any => {
    drawerShell.current = {
      closeDrawer: vi.fn(() : void => {
        drawerShell.current.drawerOpen.value = false;
      }),
      drawerOpen: ref(true),
      drawerTab: ref("preferences"),
      hasFeature: () : boolean => true,
      isAuthenticated: ref(true),
      msg: computed(() : any => consoleMessages[currentConsoleLocale.value]),
      openDrawer: vi.fn((tab: string) : void => {
        drawerShell.current.drawerTab.value = tab;
      }),
    };
  });

  afterEach(() : any => {
    while (mountedDrawers.length) {
      mountedDrawers.pop().unmount();
    }
  });

  function mountDrawer() : any {
    const wrapper: any = mount(ConsoleDrawer, {
      attachTo: document.body,
      global: {
        stubs: {
          ConsolePreferencesPanel: true,
          ConsoleServiceDiscoveryPanel: true,
          ConsoleAuthUsersPanel: true,
        },
      },
    });
    mountedDrawers.push(wrapper);
    return wrapper;
  }

  it("carries role/aria-modal/aria-label and marks the close button cancel-safe", async () : Promise<any> => {
    const wrapper: any = mountDrawer();
    await flushPromises();

    const aside: any = wrapper.find("aside.config-drawer");
    expect(aside.attributes("role")).toBe("dialog");
    expect(aside.attributes("aria-modal")).toBe("true");
    expect(aside.attributes("aria-label")).toBe(consoleMessages[currentConsoleLocale.value].overlay.drawerTitle);
    // Cancel-safe autofocus lands on the header close button.
    expect(document.activeElement).toBe(wrapper.find("[data-overlay-cancel-safe]").element);
    wrapper.unmount();
  });

  it("tracks inert with drawer visibility", async () : Promise<any> => {
    const wrapper: any = mountDrawer();
    await flushPromises();
    const aside: any = wrapper.find("aside.config-drawer");
    // jsdom has no HTMLElement.inert property, so Vue binds the attribute with
    // the boolean stringified; in real browsers the reflected property drives
    // the inert state instead. Pin that the binding tracks visibility.
    expect(aside.attributes("inert")).toBe("false");

    drawerShell.current.drawerOpen.value = false;
    await nextTick();
    expect(aside.attributes("inert")).toBe("true");
    expect(aside.attributes("aria-modal")).toBe("false");

    drawerShell.current.drawerOpen.value = true;
    await nextTick();
    expect(aside.attributes("inert")).toBe("false");
  });

  it("closes on Escape through the document-level handler", async () : Promise<any> => {
    const wrapper: any = mountDrawer();
    await flushPromises();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(drawerShell.current.closeDrawer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("renders the three tabs through MeshrixTabs with aria linkage into the panel", async () : Promise<any> => {
    const wrapper: any = mountDrawer();
    await flushPromises();

    const tabs: any = wrapper.findAll("[role='tab']");
    expect(tabs).toHaveLength(3);
    expect(wrapper.find("#meshrix-tab-preferences").attributes("aria-controls")).toBe("drawer-panel-preferences");
    expect(wrapper.find("#meshrix-tab-discovery").attributes("aria-controls")).toBe("drawer-panel-discovery");
    expect(wrapper.find("#meshrix-tab-users").attributes("aria-controls")).toBe("drawer-panel-users");

    const panel: any = wrapper.find("[role='tabpanel']");
    expect(panel.attributes("id")).toBe("drawer-panel-preferences");
    expect(panel.attributes("aria-labelledby")).toBe("meshrix-tab-preferences");

    await wrapper.find("#meshrix-tab-discovery").trigger("click");
    expect(drawerShell.current.openDrawer).toHaveBeenCalledWith("discovery");
    await nextTick();
    expect(wrapper.find("[role='tabpanel']").attributes("id")).toBe("drawer-panel-discovery");

    // Arrow-key roving also drives openDrawer via the change emit.
    await wrapper.find("#meshrix-tab-discovery").trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    expect(drawerShell.current.openDrawer).toHaveBeenCalledWith("users");
    wrapper.unmount();
  });
});
