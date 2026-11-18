// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyAppearancePresetDocument,
  refreshAvailableAppearancePresetConfigs,
  readStoredAppearancePreset,
  readAvailableAppearancePresetConfigs,
  setServerAppearancePresetConfigs,
} from "../../../apps/console/composables/console-shell-preference-effects";
import type { AppearancePresetConfig } from "../../../apps/console/lib/appearance-preset-config";

describe("console appearance preferences", () : any => {
  beforeEach(() : any => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-appearance-preset");
    document.documentElement.classList.remove("theme-dark", "theme-light");
  });

  it("returns null for an unknown appearance preset id", () : any => {
    window.localStorage.setItem("meshrix-appearance-preset", "unknown-preset");

    expect(readStoredAppearancePreset()).toBeNull();
    expect(window.localStorage.getItem("meshrix-appearance-preset")).toBe("unknown-preset");
  });

  it("applies the active preset through the document dataset", () : any => {
    document.documentElement.classList.add("theme-dark", "theme-light");

    applyAppearancePresetDocument("sunset-ember");

    expect(document.documentElement.dataset.appearancePreset).toBe("sunset-ember");
    expect(document.documentElement.dataset.appearanceColorScheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#f97316");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-light")).toBe(false);
  });

  it("refreshes the Vue/Vite preset file catalog", async () : Promise<any> => {
    const configs: any = await refreshAvailableAppearancePresetConfigs();
    const ids: any = configs.map((config?: any) : any => config.id);

    expect(ids).toContain("geek-light-blue");
    expect(ids).toContain("catppuccin-latte");
    expect(ids).toContain("github-light");
    expect(ids).toContain("one-light");
    expect(ids).toContain("dracula");
    expect(ids).toContain("nord");
    expect(ids).toContain("gruvbox-dark");
    expect(ids).toContain("tokyo-night");
  });

  it("keeps bundled dark presets in the Chinese console order", async () : Promise<any> => {
    await refreshAvailableAppearancePresetConfigs();
    const configs: any = setServerAppearancePresetConfigs([]);
    const darkPresets: any = configs
      .filter((config?: any) : any => config.mode === "dark")
      .map((config?: any) : any => [config.id, config.label["zh-CN"]]);

    expect(darkPresets).toEqual([
      ["meshrix-crystal", "黑晶蓝调"],
      ["sunset-ember", "落日余烬"],
      ["tokyo-night", "东京之夜"],
      ["cappuccino-dark", "卡布奇诺"],
      ["gruvbox-dark", "复古唱片"],
      ["dracula", "盛夜古堡"],
      ["nord", "诺德风格"],
      ["monokai", "绿野仙踪"],
      ["cyberpunk", "赛博朋克"],
    ]);
  });

  it("applies the Meshrix.js Crystal dark palette with a blue primary", async () : Promise<any> => {
    await refreshAvailableAppearancePresetConfigs();

    applyAppearancePresetDocument("meshrix-crystal");

    const expectedTokens: Record<string, any> = {
      "--bg-base": "#070707",
      "--bg-surface": "#0d0d0d",
      "--bg-subtle": "#151515",
      "--bg-inset": "#020202",
      "--border-subtle": "#242424",
      "--border-strong": "#3a3a3a",
      "--text-primary": "#ededed",
      "--text-secondary": "#c8c8c8",
      "--text-muted": "#969696",
      "--text-disabled": "#5c5c5c",
      "--text-on-brand": "#061021",
      "--brand": "#6aa1ff",
      "--brand-strong": "#93bdff",
      "--brand-subtle": "#12203a",
      "--brand-muted": "#3f5a8c",
      "--info": "#5ed7f2",
      "--success": "#3ddc97",
      "--warning": "#ff9e2c",
      "--danger": "#ff5a4e",
    };

    expect(document.documentElement.dataset.appearancePreset).toBe("meshrix-crystal");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    for (const [tokenName, value] of (Object.entries(expectedTokens) as [string, any][])) {
      expect(document.documentElement.style.getPropertyValue(tokenName)).toBe(value);
    }
  });

  it("merges server-imported preset configs with bundled preset files", () : any => {
    const configs: any = setServerAppearancePresetConfigs([
      {
        schemaVersion: "v0.0.1:schema:definition-1",
        id: "agent-preview",
        label: { en: "Agent Preview", "zh-CN": "智能体预览" },
        mode: "light",
        tokens: {
          "bg-base": "#fefce8",
          "bg-surface": "#ffffff",
          "bg-subtle": "#fef9c3",
          "text-primary": "#1f2937",
          "text-muted": "#854d0e",
          "text-on-brand": "#111827",
          "brand": "#eab308",
          "brand-strong": "#ca8a04",
          "brand-subtle": "#fef3c7",
          "success": "#15803d",
          "warning": "#b45309",
          "danger": "#b91c1c"
        },
      },
    ]);

    expect(configs.map((config?: any) : any => config.id)).toContain("geek-light-blue");
    expect(readAvailableAppearancePresetConfigs().map((config?: any) : any => config.id)).toContain("agent-preview");
  });

  it("applies a framework-provided custom preset config immediately", () : any => {
    const customConfig: AppearancePresetConfig = {
      schemaVersion: "v0.0.1:schema:definition-1",
      id: "agent-preview",
      label: { en: "Agent Preview", "zh-CN": "智能体预览" },
      mode: "light",
      tokens: {
        "bg-base": "#fefce8",
        "bg-surface": "#ffffff",
        "bg-subtle": "#fef9c3",
        "text-primary": "#1f2937",
        "text-muted": "#854d0e",
        "text-on-brand": "#111827",
        "brand": "#eab308",
        "brand-strong": "#ca8a04",
        "brand-subtle": "#fef3c7",
        "success": "#15803d",
        "warning": "#b45309",
        "danger": "#b91c1c"
      },
    };

    applyAppearancePresetDocument("agent-preview", [customConfig]);

    expect(document.documentElement.dataset.appearancePreset).toBe("agent-preview");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#eab308");
  });
});
