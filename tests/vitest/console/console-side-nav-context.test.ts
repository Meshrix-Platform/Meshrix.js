// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConsoleSideNavContext,
  type ConsoleSideNavContext,
} from "../../../apps/console/composables/consoleSideNavContext";
import type { ServerConsoleShellContext } from "../../../apps/console/composables/useServerConsoleShell";
import type { AppView } from "../../../apps/console/types/app";

const mounted: VueWrapper[] = [];

function setViewportWidth(width: number) : any {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function mountContext(initialView: AppView = "dashboard") : any {
  let context: ConsoleSideNavContext | undefined;
  const activeRouteView: any = ref<AppView>(initialView);
  const sideNavCollapsed: any = ref(false);
  const shell: any = {
    activeRouteView,
    sideNavCollapsed,
  } as unknown as ServerConsoleShellContext;
  const Host: any = defineComponent({
    setup() : any {
      context = createConsoleSideNavContext(shell);
      return () : any => null;
    },
  });
  mounted.push(mount(Host));
  if (!context) {
    throw new Error("Side nav context was not created");
  }
  return { activeRouteView, context, sideNavCollapsed };
}

beforeEach(() : any => {
  window.localStorage.clear();
  setViewportWidth(1440);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() : any => {
  while (mounted.length) {
    mounted.pop()?.unmount();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("console side nav width bounds", () : any => {
  it("clamps persisted and setter widths while preserving main content space", async () : Promise<any> => {
    window.localStorage.setItem("meshrix:console:sideNavWidth", "99999");
    window.localStorage.setItem("meshrix:console:sideNavDirectoryWidth", "99999");

    const { context } = mountContext("workspaces");
    await nextTick();

    expect(context.sideNavWidth.value).toBe(740);
    expect(context.sideNavDirectoryWidth.value).toBe(220);

    context.setSideNavWidth(99999);
    context.setSideNavDirectoryWidth(99999);

    expect(context.sideNavWidth.value).toBe(740);
    expect(context.sideNavDirectoryWidth.value).toBe(220);
    expect(context.sideNavWidth.value + context.sideNavDirectoryWidth.value + 480).toBeLessThanOrEqual(1440);
  });

  it("reconverges both widths when the viewport shrinks", async () : Promise<any> => {
    const { context } = mountContext("workspaces");
    await nextTick();
    context.setSideNavWidth(420);
    context.setSideNavDirectoryWidth(500);

    setViewportWidth(980);
    window.dispatchEvent(new Event("resize"));
    await nextTick();

    expect(context.sideNavWidth.value).toBe(280);
    expect(context.sideNavDirectoryWidth.value).toBe(220);
    expect(context.sideNavWidth.value + context.sideNavDirectoryWidth.value + 480).toBe(980);
  });

  it("treats the primary nav as an overlay at narrow desktop widths", async () : Promise<any> => {
    setViewportWidth(800);
    const { context } = mountContext("workspaces");
    await nextTick();

    context.setSideNavWidth(99999);
    context.setSideNavDirectoryWidth(99999);

    expect(context.sideNavWidth.value).toBe(320);
    expect(context.sideNavDirectoryWidth.value).toBe(320);
  });

  it("falls back safely when browser storage is empty, malformed, or unavailable", () : any => {
    window.localStorage.setItem("meshrix:console:sideNavWidth", "   ");
    window.localStorage.setItem("meshrix:console:sideNavDirectoryWidth", "not-a-number");
    const first: any = mountContext();

    expect(first.context.sideNavWidth.value).toBe(220);
    expect(first.context.sideNavDirectoryWidth.value).toBe(220);

    mounted.pop()?.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() : any => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() : any => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const second: any = mountContext();

    expect(second.context.sideNavWidth.value).toBe(220);
    expect(() : any => second.context.setSideNavWidth(260)).not.toThrow();
    expect(second.context.sideNavWidth.value).toBe(260);
  });
});
