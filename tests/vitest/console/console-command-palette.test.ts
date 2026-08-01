// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeConsoleCommandPalette,
  filterConsoleCommandPaletteItems,
  groupConsoleCommandPaletteItems,
  openConsoleCommandPalette,
  resolveAdminSectionLabel,
  resolveAdminViewLabel,
  toggleConsoleCommandPalette,
  useConsoleCommandPalette,
  type ConsoleCommandPaletteItem,
} from "../../../apps/console/composables/console-command-palette-controller";

const nav: Record<string, any> = {
  nav: {
    agents: "智能体",
    integrations: "集成",
    agentTools: "操作权限",
    system: "系统",
    operations: "运维",
    version: "版本",
    overview: "运行状态",
    jobs: "工作队列",
  },
};

function makeItem(id: string, label: string, sectionLabel: any = "系统", keywords: string[] = []): ConsoleCommandPaletteItem {
  return { id, label, sectionLabel, keywords, activate: () : any => {} };
}

beforeEach(() : any => {
  closeConsoleCommandPalette();
});

describe("console command palette controller", () : any => {
  it("opens, closes and toggles while resetting query and active index", () : any => {
    const { paletteOpen, query, activeIndex } = useConsoleCommandPalette();

    expect(paletteOpen.value).toBe(false);
    openConsoleCommandPalette();
    expect(paletteOpen.value).toBe(true);

    query.value = "jobs";
    activeIndex.value = 3;
    toggleConsoleCommandPalette();
    expect(paletteOpen.value).toBe(false);

    toggleConsoleCommandPalette();
    expect(paletteOpen.value).toBe(true);
    expect(query.value).toBe("");
    expect(activeIndex.value).toBe(0);
  });

  it("filters items by label, section label and keywords case-insensitively", () : any => {
    const items: any[] = [
      makeItem("dashboard", "工作台", "主导航"),
      makeItem("jobs", "工作队列", "运维", ["jobs", "job queue"]),
      makeItem("logs", "日志记录", "系统", ["logs"]),
    ];

    expect(filterConsoleCommandPaletteItems(items, "")).toHaveLength(3);
    expect(filterConsoleCommandPaletteItems(items, "  ").map((item?: any) : any => item.id)).toEqual(["dashboard", "jobs", "logs"]);
    expect(filterConsoleCommandPaletteItems(items, "工作队列").map((item?: any) : any => item.id)).toEqual(["jobs"]);
    expect(filterConsoleCommandPaletteItems(items, "JOBS").map((item?: any) : any => item.id)).toEqual(["jobs"]);
    expect(filterConsoleCommandPaletteItems(items, "运维").map((item?: any) : any => item.id)).toEqual(["jobs"]);
    expect(filterConsoleCommandPaletteItems(items, "不存在")).toHaveLength(0);
  });

  it("groups items into unique sections preserving first-occurrence order", () : any => {
    const items: any[] = [
      makeItem("storage", "运行状态", "系统"),
      makeItem("jobs", "工作队列", "运维"),
      makeItem("logs", "日志记录", "系统"),
      makeItem("opsMonitor", "运维监控", "运维"),
    ];

    const groups: any = groupConsoleCommandPaletteItems(items);

    expect(groups.map((group?: any) : any => group.sectionLabel)).toEqual(["系统", "运维"]);
    expect(groups[0].items.map((item?: any) : any => item.id)).toEqual(["storage", "logs"]);
    expect(groups[1].items.map((item?: any) : any => item.id)).toEqual(["jobs", "opsMonitor"]);
    expect(new Set<any>(groups.map((group?: any) : any => group.sectionLabel)).size).toBe(groups.length);
  });

  it("resolves admin section and view labels with the storage fallback", () : any => {
    expect(resolveAdminSectionLabel("agent", nav)).toBe("智能体");
    expect(resolveAdminSectionLabel("operations", nav)).toBe("运维");
    expect(resolveAdminSectionLabel("primary", nav)).toBe("");

    expect(resolveAdminViewLabel("storage", nav)).toBe("运行状态");
    expect(resolveAdminViewLabel("jobs", nav)).toBe("工作队列");
    expect(resolveAdminViewLabel("unknownView", nav)).toBe("unknownView");
  });
});
