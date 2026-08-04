// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computed, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { createRouter, createWebHashHistory, type Router } from "vue-router";
import { useConsoleUrlState } from "../../../apps/console/composables/use-console-url-state";
import { createConsoleSystemLogController } from "../../../apps/console/composables/console-system-log-controller";
import type { SystemLogRow } from "../../../apps/console/types/app";

const TestRoute: any = defineComponent({
  name: "TestRoute",
  setup: () : any => () : any => h("div"),
});

function createTestRouter() : Router {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/", component: TestRoute },
      { path: "/admin/logs", component: TestRoute },
    ],
  });
}

// Mounts a host component that binds one useConsoleUrlState ref, with the
// router already resolved at `initialUrl` (mirrors a shared/deep link).
async function mountUrlState(
  initialUrl: string,
  key: string = "tab",
  defaultValue: string = "basic",
): Promise<{ router: Router; state: Ref<string> }> {
  const router: Router = createTestRouter();
  await router.push(initialUrl);
  await router.isReady();
  let state: Ref<string> | null = null;
  mount(
    defineComponent({
      setup: () : any => {
        state = useConsoleUrlState(key, defaultValue) as Ref<string>;
        return () : any => h("div");
      },
    }),
    { global: { plugins: [router] } },
  );
  await nextTick();
  return { router, state: state as unknown as Ref<string> };
}

beforeEach(() : any => {
  // Hash history writes into the shared jsdom location; reset between tests.
  window.history.replaceState(null, "", "/");
});

afterEach(() : any => {
  window.history.replaceState(null, "", "/");
});

describe("useConsoleUrlState", () : any => {
  it("reads the query value on mount and falls back to the default", async () : Promise<any> => {
    const linked: any = await mountUrlState("/?tab=operations");
    expect(linked.state.value).toBe("operations");

    const plain: any = await mountUrlState("/");
    expect(plain.state.value).toBe("basic");
  });

  it("takes the first value when the query key is repeated", async () : Promise<any> => {
    const { state } = await mountUrlState("/?tab=advanced&tab=credentials");
    expect(state.value).toBe("advanced");
  });

  it("ignores unknown query keys", async () : Promise<any> => {
    const { state } = await mountUrlState("/?unrelated=value&other=1");
    expect(state.value).toBe("basic");
  });

  it("round-trips ref -> URL through router.replace with hash-history URLs", async () : Promise<any> => {
    const { router, state } = await mountUrlState("/");
    state.value = "operations";
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe("operations");
    // Hash history keeps the query after `#`; it is never written to location.hash by hand.
    expect(window.location.hash).toBe("#/?tab=operations");
  });

  it("round-trips URL -> ref on external query changes (back/forward)", async () : Promise<any> => {
    const { router, state } = await mountUrlState("/?tab=operations");
    expect(state.value).toBe("operations");
    await router.replace({ query: { tab: "credentials" } });
    await flushPromises();
    expect(state.value).toBe("credentials");
    await router.replace({ query: {} });
    await flushPromises();
    expect(state.value).toBe("basic");
  });

  it("elides the default value from the URL", async () : Promise<any> => {
    const { router, state } = await mountUrlState("/?tab=operations");
    state.value = "basic";
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBeUndefined();
    expect(router.currentRoute.value.fullPath).toBe("/");
  });

  it("never writes the URL when the value stays at the default", async () : Promise<any> => {
    const { router, state } = await mountUrlState("/");
    state.value = "basic";
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/");
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it("preserves foreign query keys, including the ?serviceId= deep link", async () : Promise<any> => {
    const { router, state } = await mountUrlState("/?serviceId=svc-1&other=keep");
    state.value = "operations";
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query.serviceId).toBe("svc-1");
    expect(router.currentRoute.value.query.other).toBe("keep");
    expect(router.currentRoute.value.query.tab).toBe("operations");
    state.value = "basic";
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query.serviceId).toBe("svc-1");
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it("yields to an explicit path navigation issued right after a state change", async () : Promise<any> => {
    // vue-router cancels the older pending navigation when two race, so the
    // query replace must start first and lose; otherwise fallback pushes like
    // openAdmin's restricted-route redirect would be silently dropped.
    const { router, state } = await mountUrlState("/?tab=operations");
    state.value = "credentials";
    await nextTick();
    await router.push("/admin/logs");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/admin/logs");
  });

  it("throws instead of silently no-oping when no router is installed", () : any => {
    expect(() : any => {
      mount(
        defineComponent({
          setup: () : any => {
            useConsoleUrlState("tab", "basic");
            return () : any => h("div");
          },
        }),
      );
    }).toThrowError(/useConsoleUrlState requires an active vue-router/);
  });
});

describe("useConsoleUrlState system log adoption", () : any => {
  function logRow(id: string, kindLabel: string, status: string, occurredAt: string): SystemLogRow {
    return {
      logId: id,
      kindLabel,
      displayId: id,
      target: `target-${id}`,
      status,
      statusLabel: status,
      tone: "info",
      stage: "test-stage",
      occurredAt,
      createdAt: occurredAt,
      progressPercent: 0,
      detail: "",
      error: "",
    };
  }

  async function mountLogController(
    initialUrl: string,
  ): Promise<{ router: Router; controller: any }> {
    const router: Router = createTestRouter();
    await router.push(initialUrl);
    await router.isReady();
    const sourceRows: any = ref<SystemLogRow[]>([
      logRow("alpha", "服务端任务", "running", "2026-07-10T12:00:00.000Z"),
      logRow("beta", "监控报警", "failed", "2026-07-09T12:00:00.000Z"),
    ]);
    let controller: any = null;
    mount(
      defineComponent({
        setup: () : any => {
          controller = createConsoleSystemLogController({
            serverLogRows: computed(() : any => sourceRows.value),
          });
          return () : any => h("div");
        },
      }),
      { global: { plugins: [router] } },
    );
    await nextTick();
    return { router, controller };
  }

  it("hydrates LogsView filters and pagination from the URL on mount", async () : Promise<any> => {
    const { controller } = await mountLogController(
      "/admin/logs?log.fuzzy=beta&log.page=2&log.pageSize=10",
    );
    expect(controller.systemLogFilters.value.fuzzy).toBe("beta");
    expect(controller.systemLogFilters.value.kind).toBe("all");
    expect(controller.systemLogCurrentPage.value).toBe(2);
    expect(controller.systemLogPageSize.value).toBe(10);
    // The URL-pinned page survives hydration: a deep link must not be reset to page 1.
    expect(controller.systemLogPageTotal.value).toBe(1);
    expect(controller.systemLogCurrentPage.value).toBe(2);
  });

  it("reflects LogsView filter and pagination edits in route.query", async () : Promise<any> => {
    const { router, controller } = await mountLogController("/admin/logs");
    controller.systemLogFilters.value.kind = "监控报警";
    controller.systemLogCurrentPage.value = 2;
    controller.systemLogPageSize.value = 10;
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query["log.kind"]).toBe("监控报警");
    expect(router.currentRoute.value.query["log.pageSize"]).toBe("10");
    // Editing filters resets paging to the first page, and the default stays out of the URL.
    expect(controller.systemLogCurrentPage.value).toBe(1);
    expect(router.currentRoute.value.query["log.page"]).toBeUndefined();
    expect(window.location.hash).toContain("#/admin/logs?");
    expect(window.location.hash).toContain("log.kind=");

    controller.systemLogPageSize.value = 20;
    await nextTick();
    await flushPromises();
    expect(router.currentRoute.value.query["log.pageSize"]).toBeUndefined();
  });
});
