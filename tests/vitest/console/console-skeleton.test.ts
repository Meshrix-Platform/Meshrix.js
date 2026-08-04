// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";

import ConsoleSkeleton from "../../../apps/console/components/ConsoleSkeleton.vue";
import ServerConsoleApp from "../../../apps/console/ServerConsoleApp.vue";
import { consoleMessages } from "../../../apps/console/i18n/console";

const shellHarness: any = vi.hoisted(() : any => ({}));

vi.mock("vue-router", () : any => ({
  useRoute: () : any => shellHarness.route,
  useRouter: () : any => ({
    isReady: () : Promise<any> => Promise.resolve(),
    replace: vi.fn(),
  }),
}));

vi.mock("../../../apps/console/composables/useServerConsoleShell", async () : Promise<any> => {
  const vue: any = await import("vue");
  const i18n: any = await import("../../../apps/console/i18n/console");
  const consoleState: any = vue.ref(null);
  const isAuthenticated: any = vue.ref(true);
  const canAccess: any = vue.ref(false);
  const route: any = vue.reactive({ path: "/workspaces", fullPath: "/workspaces", meta: {}, query: {} });
  Object.assign(shellHarness, { consoleState, isAuthenticated, canAccess, route });
  return {
    useServerConsoleShell: () : any => ({
      consoleBootstrapping: vue.ref(false),
      activeConsoleFeatureIds: vue.ref([]),
      canAccessRouteMeta: () : any => canAccess.value,
      consoleState,
      error: vue.ref(null),
      firstAccessibleRoutePath: () : any => "/",
      isAuthenticated,
      msg: vue.ref(i18n.consoleMessages["zh-CN"]),
      sideNavCollapsed: vue.ref(false),
      currentUserScopes: vue.ref([]),
    }),
  };
});

vi.mock("../../../apps/console/composables/consoleSideNavContext", async () : Promise<any> => {
  const vue: any = await import("vue");
  return {
    createConsoleSideNavContext: () : any => ({
      activeSideNavDirectory: vue.ref(null),
      showSideNavDirectory: vue.ref(false),
      sideNavWidth: vue.ref(260),
      sideNavDirectoryWidth: vue.ref(280),
    }),
    provideConsoleSideNavContext: () : any => {},
  };
});

vi.mock("@meshrix/ui-console/server-console-shell-context", () : any => ({
  provideServerConsoleShell: () : any => {},
}));

const stubShellComponent: any = vi.hoisted(() : any => (name: string) : any => ({
  default: { name, setup: () : any => () : any => null },
}));

vi.mock("../../../apps/console/components/shell/ConsoleCommandPalette.vue", () : any => stubShellComponent("ConsoleCommandPalette"));
vi.mock("../../../apps/console/components/ConsoleConfirmDialog.vue", () : any => stubShellComponent("ConsoleConfirmDialog"));
vi.mock("../../../apps/console/components/ConsoleToastHost.vue", () : any => stubShellComponent("ConsoleToastHost"));
vi.mock("../../../apps/console/components/shell/ConsoleDrawer.vue", () : any => stubShellComponent("ConsoleDrawer"));
vi.mock("../../../apps/console/components/shell/ConsoleSideNav.vue", () : any => stubShellComponent("ConsoleSideNav"));
vi.mock("../../../apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue", () : any => stubShellComponent("ConsoleSideNavDirectory"));
vi.mock("../../../apps/console/components/shell/ConsoleTopbar.vue", () : any => stubShellComponent("ConsoleTopbar"));
vi.mock("../../../apps/console/components/shell/ServerPathPickerDialog.vue", () : any => stubShellComponent("ServerPathPickerDialog"));

const RouterViewStub: any = {
  name: "RouterView",
  setup: () : any => () : any => h("div", { class: "router-view-stub" }),
};

function mountApp() : any {
  return mount(ServerConsoleApp, {
    global: {
      stubs: { RouterView: RouterViewStub },
    },
  });
}

beforeEach(() : any => {
  shellHarness.consoleState.value = null;
  shellHarness.isAuthenticated.value = true;
  shellHarness.canAccess.value = false;
  shellHarness.route.path = "/workspaces";
  shellHarness.route.fullPath = "/workspaces";
  shellHarness.route.meta = {};
  shellHarness.route.query = {};
});

describe("ConsoleSkeleton", () : any => {
  it("maps every variant onto the existing skeleton utility classes", () : any => {
    const variants: any = ["text", "text-sm", "text-lg", "title", "circle", "pill", "btn", "icon", "avatar", "card", "block", "row"] as const;
    for (const variant of variants) {
      const wrapper: any = mount(ConsoleSkeleton, { props: { variant } });
      const bar: any = wrapper.find("span.skeleton");
      expect(bar.exists()).toBe(true);
      expect(bar.classes()).toContain(`sk-${variant}`);
      expect(bar.classes()).toContain("sk-pulse");
      expect(bar.attributes("aria-hidden")).toBe("true");
    }
  });

  it("defaults to a single pulsing text line without a width modifier", () : any => {
    const wrapper: any = mount(ConsoleSkeleton);
    const bars: any = wrapper.findAll("span.skeleton");
    expect(bars).toHaveLength(1);
    expect(bars[0].classes()).toEqual(expect.arrayContaining(["skeleton", "sk-text", "sk-pulse"]));
    expect(bars[0].classes()).not.toContain("sk-full");
    expect(bars[0].classes()).not.toContain("sk-half");
    expect(bars[0].classes()).not.toContain("sk-third");
  });

  it("repeats lines and applies the width modifier to every line", () : any => {
    const wrapper: any = mount(ConsoleSkeleton, {
      props: { variant: "text", lines: 4, width: "half" },
    });
    const bars: any = wrapper.findAll("span.skeleton");
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar.classes()).toEqual(expect.arrayContaining(["skeleton", "sk-text", "sk-half", "sk-pulse"]));
      expect(bar.attributes("aria-hidden")).toBe("true");
    }
  });

  it("omits the pulse class when pulse is false and clamps invalid line counts", () : any => {
    const staticBar: any = mount(ConsoleSkeleton, { props: { pulse: false } });
    expect(staticBar.find("span.skeleton").classes()).not.toContain("sk-pulse");

    const clamped: any = mount(ConsoleSkeleton, { props: { lines: 0 } });
    expect(clamped.findAll("span.skeleton")).toHaveLength(1);
  });
});

describe("ServerConsoleApp cold boot", () : any => {
  it("renders ConsoleSkeleton while the authenticated route is not renderable", async () : Promise<any> => {
    const wrapper: any = mountApp();
    await flushPromises();

    const status: any = wrapper.find('.view-content [role="status"]');
    expect(status.exists()).toBe(true);
    expect(status.find(".visually-hidden").text()).toBe(consoleMessages["zh-CN"].skeleton.loading);

    const bars: any = status.findAll("span.skeleton");
    expect(bars).toHaveLength(5);
    expect(bars[0].classes()).toContain("sk-title");
    expect(bars.slice(1).every((bar?: any) : any => bar.classes().includes("sk-text"))).toBe(true);
    expect(bars.every((bar?: any) : any => bar.attributes("aria-hidden") === "true")).toBe(true);
    expect(wrapper.find(".router-view-stub").exists()).toBe(false);
  });

  it("swaps the skeleton for the route view once the route becomes renderable", async () : Promise<any> => {
    const wrapper: any = mountApp();
    await flushPromises();
    expect(wrapper.find('.view-content [role="status"]').exists()).toBe(true);

    shellHarness.consoleState.value = { server: { url: "https://server.example" } };
    shellHarness.canAccess.value = true;
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(wrapper.find('.view-content [role="status"]').exists()).toBe(false);
    expect(wrapper.find(".router-view-stub").exists()).toBe(true);
  });

  it("does not render the skeleton before auth resolves", async () : Promise<any> => {
    shellHarness.isAuthenticated.value = false;
    const wrapper: any = mountApp();
    await flushPromises();

    expect(wrapper.find('.view-content [role="status"]').exists()).toBe(false);
    expect(wrapper.find(".router-view-stub").exists()).toBe(false);
  });
});
