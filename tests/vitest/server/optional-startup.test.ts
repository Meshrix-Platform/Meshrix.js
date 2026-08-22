import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { OPTIONAL_STARTUP_TARGETS } from "../../../tools/optional-startup/catalog.ts";
import { parseOptionalStartupArgs } from "../../../tools/optional-startup/contract.ts";
import {
  listOptionalStartupTargets,
  loadOptionalStartupTargetScript,
  startOptionalTargets,
} from "../../../tools/optional-startup/runner.ts";
import { NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS } from "../../../tools/server-scripts/native-orb-deploy.ts";

const temporaryDirectories: any[] = [];
const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryDirectories.splice(0).map((directory?: any) : any => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("optional external startup", () : any => {
  it("keeps the empty selection inert", async () : Promise<any> => {
    expect(parseOptionalStartupArgs([])).toEqual({
      mode: "start",
      targets: [],
      runtimeConfigPath: "",
      environmentFiles: {},
    });
    let loads: any = 0;
    const controller: any = await startOptionalTargets({
      targets: [],
      loadTarget: async () : Promise<any> => { loads += 1; },
    });
    expect(loads).toBe(0);
    expect(controller.summary).toEqual({ ok: true, selected: [], results: [] });
  });

  it("declares one independent script for every current optional target", async () : Promise<any> => {
    const ids: any[] = OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => entry.id);
    expect(ids).toEqual([
      "service:file-parser-format-convert",
      "service:model-gateway",
      "service:skill-hub",
      "plugin:coding-github",
      "plugin:external-gateway",
      "plugin:model-gateway",
      "plugin:shared-space",
      "plugin:skill-hub",
      "adapter:antigravity",
      "adapter:claude-code",
      "adapter:codex",
      "adapter:kimi",
      "adapter:openclaw",
      "adapter:opencode",
      "adapter:pi",
      "agent:self-maintenance",
    ]);
    expect(new Set(ids).size).toBe(16);
    expect(new Set(OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => entry.script)).size).toBe(16);
    expect(OPTIONAL_STARTUP_TARGETS.every((entry?: any) : any => (
      entry.script.startsWith("./targets/") && entry.script.endsWith(".ts")
    ))).toBe(true);
    const loaded: any[] = await Promise.all(OPTIONAL_STARTUP_TARGETS.map(loadOptionalStartupTargetScript));
    expect(loaded).toHaveLength(16);
    const pluginRegistry: any = JSON.parse(await fs.readFile(
      path.join(repoRoot, "plugins/registry/plugins.json"),
      "utf8",
    ));
    const registeredExtensionTargets: any[] = pluginRegistry.plugins.flatMap((plugin?: any) : any => {
      if (plugin.runtime) return [`plugin:${plugin.id}`];
      if (plugin.adapter) return [`adapter:${plugin.adapterContract.target}`];
      if (plugin.id === "agent-self-maintenance") return ["agent:self-maintenance"];
      return [];
    }).sort();
    expect(ids.filter((id?: any) : any => !id.startsWith("service:")).sort())
      .toEqual(registeredExtensionTargets);
    expect(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS).not.toEqual(expect.arrayContaining(
      OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => expect.objectContaining({ id: entry.id })),
    ));
    expect(listOptionalStartupTargets()).toEqual(
      OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => ({ id: entry.id, kind: entry.kind })),
    );
  });

  it("starts every selected target concurrently and preserves selection order", async () : Promise<any> => {
    const selected: any[] = ["adapter:codex", "adapter:opencode", "adapter:pi"];
    const entered: any[] = [];
    let release: any;
    const barrier: any = new Promise((resolve?: any) : any => { release = resolve; });
    let allEntered: any;
    const reached: any = new Promise((resolve?: any) : any => { allEntered = resolve; });
    const pending: any = startOptionalTargets({
      targets: selected,
      loadTarget: async (entry?: any) : Promise<any> => ({
        OPTIONAL_STARTUP_TARGET_ID: entry.id,
        async startOptionalTarget() : Promise<any> {
          entered.push(entry.id);
          if (entered.length === selected.length) allEntered();
          await barrier;
          return { id: entry.id, kind: entry.kind, status: "loaded" };
        },
      }),
    });
    await reached;
    expect(entered).toHaveLength(3);
    release();
    const controller: any = await pending;
    expect(controller.summary.selected).toEqual(selected);
    expect(controller.summary.results.map((entry?: any) : any => entry.id)).toEqual(selected);
  });

  it("loads only explicitly selected Agent adapter modules", async () : Promise<any> => {
    const selected: any[] = OPTIONAL_STARTUP_TARGETS
      .filter((entry?: any) : any => entry.kind === "adapter")
      .map((entry?: any) : any => entry.id);
    const controller: any = await startOptionalTargets({ targets: selected });
    expect(controller.summary.selected).toEqual(selected);
    expect(controller.summary.results).toEqual(selected.map((id?: any) : any => ({
      id,
      kind: "adapter",
      status: "loaded",
    })));
  });

  it("requires plugin parameters to exactly match the runtime configuration", async () : Promise<any> => {
    const directory: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-optional-startup-test-"));
    temporaryDirectories.push(directory);
    const runtimeConfigPath: any = path.join(directory, "runtime.json");
    await fs.writeFile(runtimeConfigPath, JSON.stringify({
      runtime: { enabledPlugins: ["shared-space"] },
    }));
    await expect(startOptionalTargets({
      targets: ["plugin:model-gateway"],
      runtimeConfigPath,
    })).rejects.toMatchObject({ code: "optional_startup_plugin_selection_mismatch" });
    await expect(startOptionalTargets({
      targets: ["plugin:model-gateway"],
    })).rejects.toMatchObject({ code: "optional_startup_runtime_config_required" });

    await fs.writeFile(runtimeConfigPath, JSON.stringify({
      runtime: { enabledPlugins: ["model-gateway"] },
    }));
    let hostStarts: any = 0;
    const controller: any = await startOptionalTargets({
      targets: ["plugin:model-gateway"],
      runtimeConfigPath,
      loadTarget: async (entry?: any) : Promise<any> => ({
        OPTIONAL_STARTUP_TARGET_ID: entry.id,
        async startOptionalTarget() : Promise<any> {
          return { id: entry.id, kind: entry.kind, status: "selected", pluginId: "model-gateway" };
        },
      }),
      startPluginHost: async () : Promise<any> => { hostStarts += 1; },
    });
    expect(hostStarts).toBe(1);
    expect(controller.summary.results).toEqual([
      { id: "plugin:model-gateway", kind: "plugin", status: "started" },
    ]);
  });

  it("applies private environment files only to their selected process target", async () : Promise<any> => {
    const directory: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-optional-startup-env-test-"));
    temporaryDirectories.push(directory);
    const environmentPath: any = path.join(directory, "environment.json");
    await fs.writeFile(environmentPath, JSON.stringify({ PORT: "8181", SERVICE_MODE: "selected" }));
    let selectedEnvironment: any = null;
    const controller: any = await startOptionalTargets({
      targets: ["service:model-gateway"],
      environmentFiles: { "service:model-gateway": environmentPath },
      loadTarget: async (entry?: any) : Promise<any> => ({
        OPTIONAL_STARTUP_TARGET_ID: entry.id,
        async startOptionalTarget(context?: any) : Promise<any> {
          selectedEnvironment = context.environmentFor(entry.id);
          return { id: entry.id, kind: entry.kind, status: "started" };
        },
      }),
    });
    expect(selectedEnvironment.PORT).toBe("8181");
    expect(selectedEnvironment.SERVICE_MODE).toBe("selected");
    expect(controller.summary.results).toEqual([
      { id: "service:model-gateway", kind: "service", status: "started" },
    ]);
  });

  it("rejects unknown, duplicate, and implicit selections", async () : Promise<any> => {
    expect(() : any => parseOptionalStartupArgs(["--target", "adapter:codex", "--target", "adapter:codex"]))
      .toThrow(/optional_startup_target_duplicate/u);
    expect(() : any => parseOptionalStartupArgs(["--all"]))
      .toThrow(/optional_startup_argument_unknown/u);
    await expect(startOptionalTargets({ targets: ["service:missing"] }))
      .rejects.toMatchObject({ code: "optional_startup_target_unknown" });
    await expect(startOptionalTargets({
      targets: [],
      runtimeConfigPath: "runtime.json",
    })).rejects.toMatchObject({ code: "optional_startup_configuration_without_target" });
  });
});
