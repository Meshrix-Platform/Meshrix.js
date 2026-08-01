import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  importServerAppearancePresetConfig,
  listServerAppearancePresetConfigs,
  serverAppearancePresetDirectory,
  validateAppearancePresetConfig
} from "../../../packages/server-runtime/src/composition/console-domain/appearance-presets/appearance-preset-store.ts";

let userDataPath: any;

function validPreset(id: any = "agent-preview") : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    id,
    label: { en: "Agent Preview", "zh-CN": "智能体预览" },
    mode: "light",
    tokens: {
      "bg-base": "#fefce8",
      "bg-surface": "#ffffff",
      "bg-subtle": "#fef9c3",
      "text-primary": "#1f2937",
      "text-muted": "#854d0e",
      "text-on-brand": "#111827",
      brand: "#eab308",
      "brand-strong": "#ca8a04",
      "brand-subtle": "#fef3c7",
      success: "#15803d",
      warning: "#b45309",
      danger: "#b91c1c"
    }
  };
}

beforeEach(async () : Promise<any> => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-appearance-presets-"));
});

afterEach(async () : Promise<any> => {
  if (userDataPath) {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

describe("appearance preset store", () : any => {
  it("validates and persists imported server appearance presets under user data", async () : Promise<any> => {
    const result: any = await importServerAppearancePresetConfig({
      userDataPath,
      config: validPreset()
    });

    const directory: any = serverAppearancePresetDirectory(userDataPath);
    expect(result.directory).toBe(directory);
    expect(result.fileName).toBe("agent-preview.json");
    expect(result.config.id).toBe("agent-preview");
    await expect(fs.stat(path.join(directory, "agent-preview.json"))).resolves.toBeTruthy();

    const listed: any = await listServerAppearancePresetConfigs({ userDataPath });
    expect(listed.configs.map((config?: any) : any => config.id)).toEqual(["agent-preview"]);
    expect(listed.errors).toEqual([]);
  });

  it("rejects invalid imported preset configs before writing files", async () : Promise<any> => {
    const invalid: any = validPreset("Bad ID");
    const validation: any = validateAppearancePresetConfig(invalid);

    expect(validation.ok).toBe(false);
    await expect(importServerAppearancePresetConfig({ userDataPath, config: invalid })).rejects.toThrow(
      "id must be kebab-case",
    );
    const listed: any = await listServerAppearancePresetConfigs({ userDataPath });
    expect(listed.configs).toEqual([]);
  });

  it("reports invalid persisted preset files without hiding valid configs", async () : Promise<any> => {
    const directory: any = serverAppearancePresetDirectory(userDataPath);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "valid.json"), `${JSON.stringify(validPreset("valid-preview"))}\n`);
    await fs.writeFile(path.join(directory, "broken.json"), "{ broken json");

    const listed: any = await listServerAppearancePresetConfigs({ userDataPath });

    expect(listed.configs.map((config?: any) : any => config.id)).toEqual(["valid-preview"]);
    expect(listed.errors).toHaveLength(1);
    expect(listed.errors[0]).toContain("broken.json");
  });
});
