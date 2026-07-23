// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConsoleSideNavContext,
  type ConsoleSideNavContext,
} from "../../../apps/console/composables/consoleSideNavContext";
import type { ServerConsoleShellContext } from "../../../apps/console/composables/serverConsoleShellContext";
import type { AppView } from "../../../apps/console/types/app";

const mounted: VueWrapper[] = [];

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function mountContext(initialView: AppView = "dashboard") {
  let context: ConsoleSideNavContext | undefined;
  const activeRouteView = ref<AppView>(initialView);
  const sideNavCollapsed = ref(false);
  const shell = {
    activeRouteView,
    sideNavCollapsed,
  } as unknown as ServerConsoleShellContext;
  const Host = defineComponent({
    setup() {
      context = createConsoleSideNavContext(shell);
      return () => null;
    },
  });
  mounted.push(mount(Host));
  if (!context) {
    throw new Error("Side nav context was not created");
  }
  return { activeRouteView, context, sideNavCollapsed };
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(1440);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  while (mounted.length) {
    mounted.pop()?.unmount();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("console side nav width bounds", () => {
  it("clamps persisted and setter widths while preserving main content space", async () => {
    window.localStorage.setItem("lico:console:sideNavWidth", "99999");
    window.localStorage.setItem("lico:console:sideNavDirectoryWidth", "99999");

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

  it("reconverges both widths when the viewport shrinks", async () => {
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

  it("treats the primary nav as an overlay at narrow desktop widths", async () => {
    setViewportWidth(800);
    const { context } = mountContext("workspaces");
    await nextTick();

    context.setSideNavWidth(99999);
    context.setSideNavDirectoryWidth(99999);

    expect(context.sideNavWidth.value).toBe(320);
    expect(context.sideNavDirectoryWidth.value).toBe(320);
  });

  it("falls back safely when browser storage is empty, malformed, or unavailable", () => {
    window.localStorage.setItem("lico:console:sideNavWidth", "   ");
    window.localStorage.setItem("lico:console:sideNavDirectoryWidth", "not-a-number");
    const first = mountContext();

    expect(first.context.sideNavWidth.value).toBe(220);
    expect(first.context.sideNavDirectoryWidth.value).toBe(220);

    mounted.pop()?.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const second = mountContext();

    expect(second.context.sideNavWidth.value).toBe(220);
    expect(() => second.context.setSideNavWidth(260)).not.toThrow();
    expect(second.context.sideNavWidth.value).toBe(260);
  });
});
