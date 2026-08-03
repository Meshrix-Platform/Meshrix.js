// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";
import {
  collectPageRefreshTasks,
  usePageRefreshHandler,
  type PageRefreshContext,
} from "@meshrix/ui-console/page-refresh";

const tagManagementContext: PageRefreshContext = {
  viewId: "admin",
  adminView: "tagManagement",
  gatewayTab: "",
  debugTab: "",
  routePath: "/admin/tag-management",
};

function mountRefreshHandlers(...handlers: Array<() => unknown>) {
  return mount(defineComponent({
    setup() {
      for (const handler of handlers) {
        usePageRefreshHandler(
          (detail) => detail.viewId === "admin" && detail.adminView === "tagManagement",
          handler,
        );
      }
      return () => h("div");
    },
  }));
}

describe("page refresh distribution", () => {
  it("collects every refreshable component registered for the current page", async () => {
    const first = vi.fn().mockResolvedValue("first");
    const second = vi.fn().mockResolvedValue("second");
    const wrapper = mountRefreshHandlers(first, second);

    try {
      const tasks = collectPageRefreshTasks(tagManagementContext);
      expect(tasks).toHaveLength(2);
      await expect(Promise.all(tasks)).resolves.toEqual(["first", "second"]);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      wrapper.unmount();
    }
  });

  it("captures synchronous handler failures as rejected refresh tasks", async () => {
    const failure = new Error("refresh failed");
    const wrapper = mountRefreshHandlers(() => {
      throw failure;
    });

    try {
      let tasks: Promise<unknown>[] = [];
      expect(() => {
        tasks = collectPageRefreshTasks(tagManagementContext);
      }).not.toThrow();
      expect(tasks).toHaveLength(1);
      await expect(tasks[0]).rejects.toBe(failure);
    } finally {
      wrapper.unmount();
    }
  });

  it("ignores handlers registered for another page", async () => {
    const handler = vi.fn();
    const wrapper = mountRefreshHandlers(handler);

    try {
      const tasks = collectPageRefreshTasks({
        ...tagManagementContext,
        adminView: "jobs",
        routePath: "/admin/jobs",
      });
      expect(tasks).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });
});
