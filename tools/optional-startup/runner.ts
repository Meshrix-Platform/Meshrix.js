import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEnabledPluginSelection } from "../server-scripts/lib/runtime-plugin-selection.ts";
import { OPTIONAL_STARTUP_TARGET_BY_ID, OPTIONAL_STARTUP_TARGETS } from "./catalog.ts";
import { loadOptionalTargetEnvironments } from "./environment.ts";
import { startOptionalTargetProcess } from "./process-target.ts";
import { startOptionalRuntimePluginHost } from "./runtime-plugin-host.ts";

const OPTIONAL_STARTUP_ROOT: any = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT: any = path.resolve(OPTIONAL_STARTUP_ROOT, "../..");

function startupError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

function exactValues(left: readonly string[], right: readonly string[]) : any {
  return left.length === right.length && left.every((value?: any, index?: any) : any => value === right[index]);
}

async function preflightRuntimePlugins(selectedTargets: readonly any[], runtimeConfigPath: string) : Promise<any> {
  const selectedPluginIds: any[] = selectedTargets
    .filter((entry?: any) : any => entry.kind === "plugin")
    .map((entry?: any) : any => entry.id.slice("plugin:".length))
    .sort();
  if (selectedPluginIds.length === 0) {
    if (runtimeConfigPath) throw startupError("optional_startup_runtime_config_without_plugin");
    return Object.freeze([]);
  }
  if (!runtimeConfigPath) throw startupError("optional_startup_runtime_config_required");

  let runtimeConfig: any;
  try {
    runtimeConfig = JSON.parse(await fs.readFile(path.resolve(runtimeConfigPath), "utf8"));
  } catch {
    throw startupError("optional_startup_runtime_config_invalid");
  }
  let configuredPluginIds: any[];
  try {
    configuredPluginIds = [...resolveEnabledPluginSelection(runtimeConfig)].sort();
  } catch {
    throw startupError("optional_startup_runtime_config_invalid");
  }
  if (!exactValues(selectedPluginIds, configuredPluginIds)) {
    throw startupError("optional_startup_plugin_selection_mismatch");
  }
  return Object.freeze(selectedPluginIds);
}

export async function loadOptionalStartupTargetScript(entry: Record<string, any>) : Promise<any> {
  const loaded: any = await import(new URL(entry.script, import.meta.url).href);
  if (loaded.OPTIONAL_STARTUP_TARGET_ID !== entry.id || typeof loaded.startOptionalTarget !== "function") {
    throw startupError("optional_startup_target_contract_invalid");
  }
  return loaded;
}

function resolveSelectedTargets(targetIds: readonly string[]) : any {
  return Object.freeze(targetIds.map((targetId?: any) : any => {
    const entry: any = OPTIONAL_STARTUP_TARGET_BY_ID.get(targetId);
    if (!entry) throw startupError("optional_startup_target_unknown");
    return entry;
  }));
}

export async function startOptionalTargets(options: Record<string, any>) : Promise<any> {
  const selectedTargets: any = resolveSelectedTargets(options.targets || []);
  if (selectedTargets.length === 0) {
    if (options.runtimeConfigPath || Object.keys(options.environmentFiles || {}).length > 0) {
      throw startupError("optional_startup_configuration_without_target");
    }
    return Object.freeze({
      summary: Object.freeze({ ok: true, selected: Object.freeze([]), results: Object.freeze([]) }),
      stop() {},
      async wait() {},
    });
  }

  await preflightRuntimePlugins(selectedTargets, options.runtimeConfigPath || "");
  const targetEnvironments: any = await loadOptionalTargetEnvironments(
    options.environmentFiles || {},
    selectedTargets,
  );
  const handles: any[] = [];
  let stopping: any = false;
  const registerHandle: any = (handle?: any) : any => handles.push(handle);
  const context: any = Object.freeze({
    repoRoot: REPO_ROOT,
    resolveRepoPath(relativePath?: any) : any { return path.resolve(REPO_ROOT, relativePath); },
    environmentFor(targetId?: any) : any { return targetEnvironments[targetId] || process.env; },
    registerHandle,
    startProcess(specification?: any) : any {
      return startOptionalTargetProcess({ ...specification, registerHandle });
    },
  });

  let results: any[];
  try {
    const loadTarget: any = options.loadTarget || loadOptionalStartupTargetScript;
    const loadedTargets: any[] = await Promise.all(selectedTargets.map(loadTarget));
    results = await Promise.all(loadedTargets.map((loaded?: any) : any => loaded.startOptionalTarget(context)));
    for (let index: any = 0; index < results.length; index += 1) {
      if (results[index]?.id !== selectedTargets[index].id || results[index]?.kind !== selectedTargets[index].kind) {
        throw startupError("optional_startup_target_result_invalid");
      }
      if (results[index].kind === "plugin" && results[index].pluginId !== results[index].id.slice("plugin:".length)) {
        throw startupError("optional_startup_target_result_invalid");
      }
    }
    if (selectedTargets.some((entry?: any) : any => entry.kind === "plugin")) {
      const startPluginHost: any = options.startPluginHost || startOptionalRuntimePluginHost;
      await startPluginHost({
        repoRoot: REPO_ROOT,
        resolveRepoPath: context.resolveRepoPath,
        runtimeConfigPath: options.runtimeConfigPath,
        registerHandle,
      });
      results = results.map((result?: any) : any => (
        result.kind === "plugin" ? Object.freeze({ ...result, status: "started" }) : result
      ));
    }
  } catch (error: any) {
    for (const handle of handles) handle.stop();
    throw error;
  }

  const publicResults: any = Object.freeze(results.map((result?: any) : any => Object.freeze({
    id: result.id,
    kind: result.kind,
    status: result.status,
  })));

  return Object.freeze({
    summary: Object.freeze({
      ok: true,
      selected: Object.freeze(selectedTargets.map((entry?: any) : any => entry.id)),
      results: publicResults,
    }),
    stop(signal: NodeJS.Signals = "SIGTERM") : any {
      stopping = true;
      for (const handle of handles) handle.stop(signal);
    },
    async wait() : Promise<any> {
      if (handles.length === 0) return;
      await new Promise((resolve?: any, reject?: any) : any => {
        let remaining: any = handles.length;
        let settled: any = false;
        for (const handle of handles) {
          void handle.completion.then((outcome?: any) : any => {
            if (!stopping && (outcome.launchError || outcome.code !== 0)) {
              if (!settled) {
                settled = true;
                for (const sibling of handles) sibling.stop();
                reject(startupError("optional_startup_target_failed"));
              }
              return;
            }
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve();
            }
          });
        }
      });
    },
  });
}

export function listOptionalStartupTargets() : any {
  return OPTIONAL_STARTUP_TARGETS.map((entry?: any) : any => Object.freeze({ id: entry.id, kind: entry.kind }));
}
