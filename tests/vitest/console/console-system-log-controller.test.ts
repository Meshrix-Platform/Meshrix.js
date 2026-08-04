// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { createConsoleSystemLogController } from "../../../apps/console/composables/console-system-log-controller";
import type { SystemLogRow } from "../../../apps/console/types/app";

const browserEffectsMock: any = vi.hoisted(() : any => ({
  downloadTextFile: vi.fn(),
}));

vi.mock("../../../apps/console/composables/console-browser-effects", () : any => ({
  downloadTextFile: browserEffectsMock.downloadTextFile,
}));

// The controller's filters/pagination are URL-backed (useConsoleUrlState), so
// it must be created inside a mounted component under an installed router.
function createRoutedController(sourceRows: any) : any {
  const router: any = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: defineComponent({ setup: () : any => () : any => h("div") }) }],
  });
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
  return controller;
}

function row(
  id: string,
  kindLabel: string,
  status: string,
  occurredAt: string,
  detail: any = "",
): SystemLogRow {
  return {
    logId: id,
    kindLabel,
    displayId: id,
    target: `target-${id}`,
    status,
    statusLabel: status === "failed" ? "失败" : "运行中",
    tone: status === "failed" ? "danger" : "info",
    stage: "test-stage",
    occurredAt,
    createdAt: occurredAt,
    progressPercent: status === "failed" ? 100 : 50,
    detail,
    error: status === "failed" ? "test failure" : "",
  };
}

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("console system log controller", () : any => {
  it("filters, paginates, clamps pages, and tracks table scrolling", async () : Promise<any> => {
    const sourceRows: any = ref<SystemLogRow[]>([
      row("alpha", "服务端任务", "running", "2026-07-10T12:00:00.000Z"),
      row("beta", "监控报警", "failed", "2026-07-09T12:00:00.000Z"),
      row("gamma", "服务端任务", "failed", "2026-07-08T12:00:00.000Z"),
    ]);
    const controller: any = createRoutedController(sourceRows);

    controller.systemLogPageSize.value = 1;
    await nextTick();
    expect(controller.systemLogPageTotal.value).toBe(3);
    expect(controller.systemLogPageCount.value).toBe(3);
    expect(controller.paginatedSystemLogRows.value.map((item?: any) : any => item.logId)).toEqual(["alpha"]);

    controller.goToSystemLogNextPage();
    expect(controller.systemLogCurrentPage.value).toBe(2);
    expect(controller.systemLogPageRange.value).toEqual({ start: 2, end: 2 });
    expect(controller.paginatedSystemLogRows.value.map((item?: any) : any => item.logId)).toEqual(["beta"]);

    controller.systemLogFilters.value = {
      fuzzy: "target-beta",
      kind: "监控报警",
      status: "failed",
      from: "2026-07-09",
      to: "2026-07-09",
    };
    await nextTick();
    expect(controller.systemLogCurrentPage.value).toBe(1);
    expect(controller.filteredSystemLogRows.value.map((item?: any) : any => item.logId)).toEqual(["beta"]);

    controller.handleSystemLogTableScroll({ scrollTop: 72 });
    expect(controller.systemLogScrollTop.value).toBe(72);
    expect(controller.systemLogKindOptionBarOptions.value).toContainEqual({
      value: "监控报警",
      label: "监控报警",
    });
    expect(controller.systemLogStatusOptionBarOptions.value).toContainEqual({
      value: "failed",
      label: "失败",
    });

    sourceRows.value = [];
    await nextTick();
    expect(controller.systemLogPageCount.value).toBe(1);
    expect(controller.systemLogPageRange.value).toEqual({ start: 0, end: 0 });
  });

  it("exports only the filtered rows as escaped UTF-8 CSV", () : any => {
    const sourceRows: any = ref<SystemLogRow[]>([
      row("alpha", "服务端任务", "running", "2026-07-10T12:00:00.000Z"),
      row("beta", "监控报警", "failed", "2026-07-09T12:00:00.000Z", 'comma, and "quote"'),
    ]);
    const controller: any = createRoutedController(sourceRows);
    controller.systemLogFilters.value.fuzzy = "beta";

    controller.exportSystemLogRows();

    expect(browserEffectsMock.downloadTextFile).toHaveBeenCalledTimes(1);
    const [fileName, content, contentType] = browserEffectsMock.downloadTextFile.mock.calls[0];
    expect(fileName).toMatch(/^meshrix-system-logs-.*\.csv$/);
    expect(contentType).toBe("text/csv;charset=utf-8");
    expect(content.startsWith("\uFEFF")).toBe(true);
    expect(content).toContain('"beta"');
    expect(content).toContain('"comma, and ""quote"""');
    expect(content).not.toContain('"alpha"');
  });
});
