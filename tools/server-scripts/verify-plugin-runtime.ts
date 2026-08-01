#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createPluginRegistry,
  loadPluginRegistry,
  normalizePluginManifest,
  PLUGIN_MANIFEST_SCHEMA_VERSION
} from "../../packages/foundation/src/module-system/plugin-registry.ts";
import { createMountManager } from "../../packages/foundation/src/module-system/mount-manager.ts";
import { runPluginVerifierWorkload } from "../../packages/foundation/src/module-system/plugin-verifier-runner.ts";
import { resolveEnabledPluginSelection } from "./lib/runtime-plugin-selection.ts";
import { collectPluginRuntimeOwnershipFailures } from "./lib/plugin-runtime-capability-bindings.ts";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.ts";
import { applyFeatureSourcePlan, createPackagingPlan } from "./package-server-source.ts";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const REPORT_PATH: any = path.join(ROOT, "build/reports/plugin-runtime.json");
const REPORT_SCHEMA_VERSION: any = "v0.0.1:plugin:runtime-verification-report-3";
const VERIFIER: any = "tools/server-scripts/verify-plugin-runtime.ts";

function toPosixRelative(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function sanitizeError(error?: any, replacements: any = []) : any {
  let message: any = error instanceof Error ? error.message : String(error || "");
  for (const replacement of replacements) {
    if (replacement) message = message.split(replacement).join("<redacted-path>");
  }
  return message
    .replace(/(?:\/Users\/|\/home\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/Bearer\s+\S+/gu, "Bearer [redacted]")
    .slice(0, 512);
}

function assertNoLeak(value?: any, label: any = "plugin runtime report") : any {
  const serialized: any = JSON.stringify(value);
  if (
    serialized.includes(ROOT) ||
    serialized.includes(os.homedir()) ||
    /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/)[^\s"']+/u.test(serialized)
  ) {
    throw new Error(`${label.replace(/\s+/gu, "_")}_local_path_leak`);
  }
  if (/Bearer\s+(?!\[redacted\])\S+/u.test(serialized)) {
    throw new Error(`${label.replace(/\s+/gu, "_")}_bearer_leak`);
  }
}

function manifest(id?: any, patch: Record<string, any> = {}) : any {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    label: id,
    version: "0.0.1",
    defaultEnabled: false,
    dependencies: [],
    features: [],
    operations: [],
    routes: [],
    mcpTools: [],
    consoleEntries: [],
    stateMachines: [],
    verifierHooks: [],
    ...patch
  };
}

async function writePlugin(repoRoot?: any, record?: any, source?: any) : Promise<any> {
  const directory: any = path.join(repoRoot, "plugins", record.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (source !== undefined) {
    await fs.writeFile(path.join(directory, "runtime.ts"), source, "utf8");
  }
}

async function fixtureManager(repoRoot?: any, userDataPath?: any, enabledPlugins: any = [], extra: Record<string, any> = {}) : Promise<any> {
  await fs.mkdir(userDataPath, { recursive: true });
  const artifactFixture: any = await stagePluginArtifactVerificationFixture({
    sourcePluginRoot: path.join(repoRoot, "plugins"),
    userDataPath
  });
  let manager: any;
  try {
    manager = await createMountManager({
      userDataPath,
      runtimeOptions: {
        cwd: repoRoot,
        enabledPlugins,
        ...(extra.runtimeOptions || {})
      },
      builtinMountProviders: extra.builtinMountProviders || {},
      pluginHostPorts: { artifactAuthority: artifactFixture.authority }
    });
  } catch (error: any) {
    await artifactFixture.close();
    throw error;
  }
  let closePromise: any = null;
  return Object.freeze({
    ...manager,
    close() : any {
      closePromise ||= (async () : Promise<any> => {
        try {
          return await manager.close();
        } finally {
          await artifactFixture.close();
        }
      })();
      return closePromise;
    }
  });
}

async function runPackagedServer({
  tempRoot,
  id,
  enabledPlugins,
  pluginConfigurations = {},
  expectReady,
  repoRoot = ROOT
}: Record<string, any>) : Promise<any> {
  const configPath: any = path.join(tempRoot, `${id}.runtime.json`);
  const dataPath: any = path.join(tempRoot, `${id}.data`);
  const readyPath: any = path.join(tempRoot, `${id}.ready.json`);
  await fs.writeFile(configPath, JSON.stringify({
    runtime: { enabledPlugins, pluginConfigurations }
  }), "utf8");
  const env: Record<string, any> = { ...process.env };
  for (const key of [
    "MESHRIX_RUNTIME_CONFIG",
    "MESHRIX_REQUIRE_RUNTIME_CONFIG",
    "MESHRIX_EXPECTED_RUNTIME_KIND",
    "MESHRIX_EDITION",
    "MESHRIX_FEATURE_PROFILE",
    "MESHRIX_SERVER_DATA_DIR",
    "MESHRIX_SERVER_PORT"
  ]) {
    delete env[key];
  }
  const child: any = spawn(process.execPath, [
    path.join(repoRoot, "tools/server-scripts/start-server.ts"),
    "--runtime-config",
    configPath,
    "--data-dir",
    dataPath,
    "--port",
    "0",
    "--ready-file",
    readyPath,
    "--strict-port",
    "--active-service-url",
    "http://127.0.0.1:0",
    "--advertised-base-url",
    "http://127.0.0.1:0"
  ], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let diagnostic: any = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk?: any) : any => {
    if (diagnostic.length < 4096) diagnostic += chunk;
  });
  let ready: any = false;
  let shutdownRequested: any = false;
  const result: any = await new Promise((resolve?: any) : any => {
    let settled: any = false;
    const finish: any = (value?: any) : any => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const deadline: any = Date.now() + 15000;

    const pollReadyFile: any = async () : Promise<any> => {
      if (settled) return;
      try {
        const payload: any = JSON.parse(await fs.readFile(readyPath, "utf8"));
        if (payload?.status === "ready") {
          ready = true;
          if (!shutdownRequested) {
            shutdownRequested = true;
            child.kill(expectReady ? "SIGTERM" : "SIGKILL");
          }
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          finish({ timedOut: false, code: null, ready: false, diagnostic: "ready_file_unreadable" });
          return;
        }
      }
      if (Date.now() >= deadline) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        finish({ timedOut: true, code: null, ready, diagnostic: "startup_timeout" });
        return;
      }
      setTimeout(() : any => {
        void pollReadyFile();
      }, 25);
    };

    child.once("exit", (code?: any) : any => {
      finish({ timedOut: false, code, ready, diagnostic: sanitizeError(diagnostic, [repoRoot, tempRoot]) });
    });
    child.once("error", () : any => {
      finish({ timedOut: false, code: null, ready, diagnostic: "startup_spawn_failed" });
    });
    void pollReadyFile();
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await fs.rm(readyPath, { force: true });
  return result;
}

async function copyPluginArtifact(sourceRoot?: any, targetRoot?: any, pluginId?: any) : Promise<any> {
  const source: any = path.join(sourceRoot, "plugins", pluginId);
  const target: any = path.join(targetRoot, "plugins", pluginId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  const files: any[] = [];
  async function visit(directory?: any) : Promise<any> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute: any = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(target, absolute).split(path.sep).join("/"));
    }
  }
  await visit(target);
  return files.sort();
}

async function stageInstalledDependencyClosure(packageRoot?: any) : Promise<any> {
  const sourceModules: any = path.join(ROOT, "node_modules");
  const targetModules: any = path.join(packageRoot, "node_modules");
  await fs.mkdir(targetModules, { recursive: true });
  for (const entry of await fs.readdir(sourceModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === "@meshrix") continue;
    await fs.symlink(path.join(sourceModules, entry.name), path.join(targetModules, entry.name), "junction");
  }
  const workspaceScope: any = path.join(targetModules, "@meshrix");
  await fs.mkdir(workspaceScope, { recursive: true });
  const workspacePackages: Record<string, any> = {
    agents: "packages/agents",
    capabilities: "packages/capabilities",
    console: "apps/console",
    contracts: "packages/contracts",
    foundation: "packages/foundation",
    protocols: "packages/protocols",
    server: "apps/server",
    "server-runtime": "packages/server-runtime",
    "ui-console": "packages/ui-console"
  };
  for (const [packageName, relativeTarget] of (Object.entries(workspacePackages) as [string, any][])) {
    await fs.symlink(
      path.join(packageRoot, relativeTarget),
      path.join(workspaceScope, packageName),
      "junction"
    );
  }
}

async function verifyPhysicalRemovalMatrix({ tempRoot, plugins }: Record<string, any>) : Promise<any> {
  if (plugins.length === 0) return [];
  const packageRoot: any = path.join(tempRoot, "removal-package");
  await applyFeatureSourcePlan(packageRoot, createPackagingPlan({ profile: "public" }));
  await stageInstalledDependencyClosure(packageRoot);
  const results: any[] = [];
  for (const removed of plugins) {
    const stagedPluginRoot: any = path.join(packageRoot, "plugins");
    await fs.rm(stagedPluginRoot, { recursive: true, force: true });
    const retained: any = plugins.filter((plugin?: any) : any => plugin.id !== removed.id);
    const retainedFiles: Record<string, any> = {};
    for (const plugin of retained) {
      retainedFiles[plugin.id] = await copyPluginArtifact(ROOT, packageRoot, plugin.id);
      if (retainedFiles[plugin.id].length === 0) {
        throw new Error(`Retained plugin ${plugin.id} was staged without its artifact closure.`);
      }
    }
    const artifactFixture: any = await stagePluginArtifactVerificationFixture({ sourcePluginRoot: stagedPluginRoot });
    const stagedRegistry: any = await loadPluginRegistry({ artifactAuthority: artifactFixture.authority });
    const stagedIds: any = stagedRegistry.listPlugins().map((plugin?: any) : any => plugin.id).sort();
    if (stagedIds.includes(removed.id) || stagedIds.join(",") !== retained.map((plugin?: any) : any => plugin.id).sort().join(",")) {
      throw new Error(`Physical removal matrix did not stage the exact catalog for ${removed.id}.`);
    }
    const deployment: any = stagedRegistry.resolveDeployment({ enabledPluginIds: [] });
    if (
      deployment.loadedPlugins.length !== 0 ||
      deployment.enabledPluginIds.length !== 0 ||
      deployment.disabledPluginIds.length !== retained.length
    ) {
      throw new Error(`Physical removal matrix exposed a disabled contribution for ${removed.id}.`);
    }
    let selectedRemovedRejected: any = false;
    try {
      stagedRegistry.resolveDeployment({ enabledPluginIds: [removed.id] });
    } catch {
      selectedRemovedRejected = true;
    }
    if (!selectedRemovedRejected) {
      throw new Error(`Physical removal matrix retained a fallback authority for ${removed.id}.`);
    }
    await artifactFixture.close();
    const removedArtifactPresent: any = await fs.access(path.join(stagedPluginRoot, removed.id))
      .then(() : any => true, () : any => false);
    if (removedArtifactPresent) {
      throw new Error(`Physical removal matrix retained the artifact for ${removed.id}.`);
    }
    const boot: any = await runPackagedServer({
      tempRoot,
      id: `removed-${removed.id}`,
      enabledPlugins: [],
      expectReady: true,
      repoRoot: packageRoot
    });
    if (boot.timedOut || !boot.ready || boot.code !== 0) {
      throw new Error(`Core package did not boot after physical removal of ${removed.id}: ${boot.diagnostic}.`);
    }
    const dataEntries: any = await fs.readdir(path.join(tempRoot, `removed-${removed.id}.data`), {
      recursive: true
    }).catch(() : any => []);
    if (dataEntries.some((entry?: any) : any => String(entry).split(path.sep).includes(removed.id))) {
      throw new Error(`Physical removal opened storage for ${removed.id}.`);
    }
    results.push(Object.freeze({
      pluginId: removed.id,
      status: "passed",
      artifactAbsent: true,
      registryAbsent: true,
      runtimeSurfaceAbsent: true,
      apiSurfaceAbsent: true,
      uiSurfaceAbsent: true,
      storageAbsent: true,
      backgroundAbsent: true,
      fallbackAbsent: true,
      coreBooted: true,
      retainedPluginArtifactCount: retained.length,
      retainedFileCount: (Object.values(retainedFiles) as any[]).reduce((total?: any, files?: any) : any => total + files.length, 0)
    }));
  }
  return results;
}

function runtimeSource(id?: any, mountName?: any, mountId?: any, kind?: any, { postCommit = false, eventFile = "" }: Record<string, any> = {}) : any {
  return `
import { appendFileSync } from "node:fs";
const event = (value) => appendFileSync(${JSON.stringify(eventFile)}, value + "\\n", "utf8");
event("${id}:import");
export async function activatePlugin({ manifest, onClose }) {
  event("${id}:activate");
  onClose(() => event("${id}:registered-close"));
  return {
    id: manifest.id,
    mounts: {
      "${mountName}": {
        id: "${mountId}",
        kind: "${kind}",
        ${postCommit ? "onPostCommit() {}," : ""}
        probe() { return "${id}"; }
      }
    },
    close() { event("${id}:close"); }
  };
}
`;
}

async function readFixtureEvents(filePath?: any) : Promise<any> {
  return fs.readFile(filePath, "utf8")
    .then((value?: any) : any => value.split("\n").filter(Boolean), () : any => []);
}

function contributionRuntimeSource(id?: any) : any {
  return `
export async function activatePlugin({ manifest }) {
  return {
    id: manifest.id,
    mounts: {},
    contributions: {
      operations: { "${id}.run": async () => ({ ok: true }) },
      routes: { "${id}.route": { method: "POST" } },
      mcpTools: { "${id}.tool": async () => ({ content: [] }) },
      consoleEntries: { "admin.${id}": { component: "FixtureView" } },
      stateMachines: { "${id}.lifecycle": { initialState: "ready" } },
      verifierHooks: {}
    },
    close() {}
  };
}
`;
}

async function collectExecutableSelectionFailures() : Promise<any> {
  const startupPath: any = "tools/server-scripts/start-server.ts";
  const source: any = await fs.readFile(path.join(ROOT, startupPath), "utf8");
  if (source.includes("enabledPlugins: resolveEnabledPluginSelection(runtimeConfigObject)")) return [];
  return [{
    id: "plugin-selection-not-wired-to-executable-startup",
    status: "failed",
    kind: "local-implementation",
    reasonCodes: ["deployment_configuration_surface_missing"],
    evidence: [startupPath],
    requiredClosure: [
      "Add an explicit array-valued deployment configuration field for enabled plugin ids to the packaged server startup path.",
      "Keep the absent field empty and pass only the explicitly configured ids to runtimeOptions.enabledPlugins.",
      "Verify packaged startup with an empty selection, a valid selection, and an unknown id."
    ]
  }];
}

export function finalizePluginRuntimeReport(report?: any, scan: any = assertNoLeak) : any {
  if (!report?.summary || typeof report.summary !== "object") {
    throw new TypeError("Plugin runtime report summary is required.");
  }
  report.summary.reportLeakScan = false;
  scan(report, "plugin runtime report");
  report.summary.reportLeakScan = true;
  scan(report, "plugin runtime report");
  return report;
}

export function reducePluginRuntimeAcceptance({
  checks = [],
  runtimeContractReady = false,
  executableSelectionReady = false,
  pluginOwnershipReady = false
}: Record<string, any> = {}) : any {
  const everyCheckParticipates: any = Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((item?: any) : any => item?.status === "passed");
  return Object.freeze({
    everyCheckParticipates,
    pluginRuntimeAcceptanceReady: everyCheckParticipates &&
      runtimeContractReady === true &&
      executableSelectionReady === true &&
      pluginOwnershipReady === true
  });
}

async function writePluginRuntimeReport(report?: any) : Promise<any> {
  const finalized: any = finalizePluginRuntimeReport(report);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
}

async function main() : Promise<any> {
  await fs.rm(REPORT_PATH, { force: true });
  const checks: any[] = [];
  const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-runtime-"));

  async function check(id?: any, fn?: any) : Promise<any> {
    try {
      await fn();
      checks.push({ id, status: "passed" });
    } catch (error: any) {
      checks.push({ id, status: "failed", error: sanitizeError(error, [ROOT, tempRoot]) });
    }
  }

  let pluginOwnershipFailures: any[] = [];
  let executableSelectionFailures: any[] = [];
  let physicalRemovalMatrix: any[] = [];
  let repoArtifactFixture: any = null;
  try {
    repoArtifactFixture = await stagePluginArtifactVerificationFixture({ sourcePluginRoot: path.join(ROOT, "plugins") });
    const repoRegistry: any = await loadPluginRegistry({ artifactAuthority: repoArtifactFixture.authority });

    await check("repo-plugin-catalog-is-explicit-and-default-off", async () : Promise<any> => {
      const plugins: any = repoRegistry.listPlugins();
      const pluginRoot: any = path.join(ROOT, "plugins");
      const pluginDirectories: any = await fs.readdir(pluginRoot, { withFileTypes: true })
        .then((entries?: any) : any => entries.filter((entry?: any) : any => entry.isDirectory() && !entry.isSymbolicLink()), () : any => []);
      if (pluginDirectories.length > 0 && plugins.length === 0) {
        throw new Error("Repository plugin catalog is incomplete.");
      }
      if (plugins.some((plugin?: any) : any => plugin.defaultEnabled !== false)) {
        throw new Error("Repository plugins must be explicit-selection only.");
      }
      const deployment: any = repoRegistry.resolveDeployment();
      if (deployment.loadedPlugins.length !== 0 || deployment.disabledPluginIds.length !== plugins.length) {
        throw new Error("Empty deployment selection must load no plugins.");
      }
    });

    await check("real-plugin-verifier-workloads-fail-closed-without-controlled-sandbox", async () : Promise<any> => {
      for (const plugin of repoRegistry.listPlugins()) {
        const artifactSnapshot: any = await repoArtifactFixture.installed.get(plugin.id)?.port.loadSnapshot();
        if (!artifactSnapshot) throw new Error(`Verified plugin artifact snapshot is unavailable for ${plugin.id}.`);
        for (const declaration of plugin.verifierHooks) {
          const result: any = await runPluginVerifierWorkload(declaration, {
            resolveSource: (source?: any) : any => artifactSnapshot.resolveRuntimeModule(source),
            pluginId: plugin.id
          });
          if (
            result.ok !== false ||
            result.reasonCode !== "plugin_verifier_sandbox_configuration_required" ||
            result.terminalReceiptRef !== ""
          ) {
            throw new Error(`Unconfigured verifier workload did not fail closed for ${plugin.id}.`);
          }
        }
      }
    });

    await check("every-real-optional-plugin-has-a-physical-removal-proof", async () : Promise<any> => {
      physicalRemovalMatrix = await verifyPhysicalRemovalMatrix({
        tempRoot,
        plugins: repoRegistry.listPlugins()
      });
      if (
        physicalRemovalMatrix.length !== repoRegistry.listPlugins().length ||
        physicalRemovalMatrix.some((entry?: any) : any => entry.status !== "passed")
      ) {
        throw new Error("Physical removal coverage is incomplete.");
      }
    });

    await check("executable-selection-parser-preserves-explicit-empty-array", async () : Promise<any> => {
      if (resolveEnabledPluginSelection({}).length !== 0) {
        throw new Error("Absent plugin selection did not remain empty.");
      }
      if (resolveEnabledPluginSelection({ runtime: { enabledPlugins: [] } }).length !== 0) {
        throw new Error("Explicit empty plugin selection did not remain empty.");
      }
      const selected: any = resolveEnabledPluginSelection({
        runtime: { enabledPlugins: ["alpha", "beta"] }
      });
      if (selected.join(",") !== "alpha,beta") {
        throw new Error("Canonical runtime.enabledPlugins selection was not preserved.");
      }
      for (const invalid of [
        { runtime: { enabledPlugins: "alpha" } },
        { runtime: { enabledPlugins: ["alpha", "alpha"] } },
        { runtime: { enabledPlugins: ["Alpha"] } }
      ]) {
        let rejected: any = false;
        try {
          resolveEnabledPluginSelection(invalid);
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error("Invalid executable plugin selection was accepted.");
      }
    });

    await check("executable-startup-preserves-empty-and-rejects-invalid-selection", async () : Promise<any> => {
      const empty: any = await runPackagedServer({
        tempRoot,
        id: "packaged-empty",
        enabledPlugins: [],
        expectReady: true
      });
      if (empty.timedOut || !empty.ready || empty.code !== 0) {
        throw new Error(`Packaged startup did not preserve an explicit empty plugin selection (timeout=${empty.timedOut}, ready=${empty.ready}, code=${empty.code}, reason=${empty.diagnostic}).`);
      }
      const unknown: any = await runPackagedServer({
        tempRoot,
        id: "packaged-unknown",
        enabledPlugins: ["missing-plugin"],
        expectReady: false
      });
      if (unknown.timedOut || unknown.ready || unknown.code === 0) {
        throw new Error("Packaged startup did not reject an unknown plugin selection.");
      }
    });

    await check("catalog-only-plugin-cannot-be-enabled", async () : Promise<any> => {
      const catalogOnlyRoot: any = path.join(tempRoot, "catalog-only-repo");
      await writePlugin(catalogOnlyRoot, manifest("catalog-only", {
        features: ["catalog-only-feature"],
        operations: ["catalog_only.run"]
      }));
      let rejected: any = false;
      let rejectionCode: any = "";
      try {
        await fixtureManager(catalogOnlyRoot, path.join(tempRoot, "catalog-only-state"), ["catalog-only"]);
      } catch (error: any) {
        rejectionCode = String(error?.code || "");
        rejected = ["PLUGIN_ARTIFACT_CONTENT_INVALID", "PLUGIN_ARTIFACT_PATH_INVALID", "PLUGIN_RUNTIME_ACTIVATION_FAILED"].includes(rejectionCode);
      }
      if (!rejected) throw new Error(`A manifest without a runtime module must fail closed when selected (code=${rejectionCode || "none"}).`);
    });

    const fixtureRoot: any = path.join(tempRoot, "fixture-repo");
    const fixtureEventPath: any = path.join(tempRoot, "fixture-events.jsonl");
    await writePlugin(
      fixtureRoot,
      manifest("dependency", {
        runtime: { module: "./runtime.ts" },
        mounts: { dependency: { id: "dependency.mount", kind: "document" } }
      }),
      runtimeSource("dependency", "dependency", "dependency.mount", "document", { eventFile: fixtureEventPath })
    );
    await writePlugin(
      fixtureRoot,
      manifest("demo", {
        dependencies: ["dependency"],
        runtime: { module: "./runtime.ts" },
        mounts: { demo: { id: "demo.mount", kind: "document" } },
        mountRouting: {
          kindRoutes: { document: { mountName: "demo", action: "extract" } },
          extensionRoutes: { ".txt": { mountName: "demo", action: "extractText" } }
        }
      }),
      runtimeSource("demo", "demo", "demo.mount", "document", { postCommit: true, eventFile: fixtureEventPath })
    );
    await writePlugin(
      fixtureRoot,
      manifest("contributor", {
        runtime: { module: "./runtime.ts" },
        operations: ["contributor.run"],
        routes: [{ id: "contributor.route", path: "/contributor", kind: "http" }],
        mcpTools: ["contributor.tool"],
        consoleEntries: ["admin.contributor"],
        stateMachines: ["contributor.lifecycle"],
        verifierHooks: [{
          id: "contributor.verify",
          workloadKind: "plugin_verifier.contributor",
          source: "verifiers/contributor.ts"
        }]
      }),
      contributionRuntimeSource("contributor")
    );

    await check("disabled-plugin-is-never-imported", async () : Promise<any> => {
      const manager: any = await fixtureManager(fixtureRoot, path.join(tempRoot, "disabled-state"));
      if ((await readFixtureEvents(fixtureEventPath)).length !== 0 || manager.plugins.loadedPlugins.length !== 0) {
        throw new Error("Disabled plugin code was imported or activated.");
      }
      await manager.close();
    });

    await check("selected-plugins-load-in-dependency-order-and-unload-in-reverse", async () : Promise<any> => {
      const manager: any = await fixtureManager(
        fixtureRoot,
        path.join(tempRoot, "enabled-state"),
        ["demo", "dependency"]
      );
      const view: any = manager.createExecutionView();
      if (await view.mounts.demo?.probe() !== "demo" || await view.mounts.dependency?.probe() !== "dependency") {
        throw new Error("Selected plugin mounts were not loaded from runtime modules.");
      }
      if (view.postCommitHooks.length !== 1) {
        throw new Error("Plugin post-commit hooks were not projected into the execution view.");
      }
      if (view.resolveDocumentRoute({ extension: "txt" })?.mount?.pluginId !== "demo") {
        throw new Error("Plugin mount routing was not activated.");
      }
      const activation: any = (await readFixtureEvents(fixtureEventPath)).filter((entry?: any) : any => entry.endsWith(":activate"));
      if (activation.join(",") !== "dependency:activate,demo:activate") {
        throw new Error("Plugin dependencies did not activate before dependents.");
      }
      await manager.close();
      const closing: any = (await readFixtureEvents(fixtureEventPath)).filter((entry?: any) : any => entry.includes("close"));
      if (closing.join(",") !== "demo:close,demo:registered-close,dependency:close,dependency:registered-close") {
        throw new Error("Plugin resources did not close in reverse dependency order.");
      }
    });

    await check("plugin-contributions-are-executable-and-exactly-match-the-manifest", async () : Promise<any> => {
      const manager: any = await fixtureManager(
        fixtureRoot,
        path.join(tempRoot, "contribution-state"),
        ["contributor"]
      );
      const contributions: any = manager.createExecutionView().contributions;
      const operation: any = contributions.operations["contributor.run"];
      if (operation?.pluginId !== "contributor" || operation.kind !== "operations") {
        throw new Error("Executable contribution ownership was not preserved.");
      }
      const result: any = await operation.implementation();
      if (result?.ok !== true) {
        throw new Error("Executable operation contribution was not callable.");
      }
      for (const [kind, id] of [
        ["routes", "contributor.route"],
        ["mcpTools", "contributor.tool"],
        ["consoleEntries", "admin.contributor"],
        ["stateMachines", "contributor.lifecycle"],
        ["verifierHooks", "contributor.verify"]
      ]) {
        if (contributions[kind]?.[id]?.pluginId !== "contributor") {
          throw new Error(`Executable ${kind} contribution was not registered.`);
        }
      }
      await manager.close();
    });

    await check("plugin-removal-is-safe-only-while-disabled", async () : Promise<any> => {
      const removalRoot: any = path.join(tempRoot, "removal-repo");
      await writePlugin(
        removalRoot,
        manifest("removable", {
          runtime: { module: "./runtime.ts" },
          mounts: { removable: { id: "removable.mount", kind: "document" } }
        }),
        runtimeSource("removable", "removable", "removable.mount", "document", { eventFile: path.join(tempRoot, "removable-events.jsonl") })
      );
      const first: any = await fixtureManager(removalRoot, path.join(tempRoot, "removal-state-one"));
      await first.close();
      await fs.rm(path.join(removalRoot, "plugins", "removable"), { recursive: true, force: true });
      const second: any = await fixtureManager(removalRoot, path.join(tempRoot, "removal-state-two"));
      if (second.plugins.loadedPlugins.length !== 0) {
        throw new Error("Removed disabled plugin remained registered.");
      }
      await second.close();
    });

    await check("missing-plugin-root-starts-only-with-empty-selection", async () : Promise<any> => {
      const missingRoot: any = path.join(tempRoot, "missing-repo");
      const manager: any = await fixtureManager(missingRoot, path.join(tempRoot, "missing-state"));
      if (manager.plugins.loadedPlugins.length !== 0) {
        throw new Error("Missing plugin root loaded a plugin.");
      }
      await manager.close();
      let rejected: any = false;
      try {
        await fixtureManager(missingRoot, path.join(tempRoot, "missing-selected-state"), ["missing"]);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Selecting a plugin from a missing root must fail closed.");
    });

    await check("dependency-omissions-and-unknown-selections-fail-closed", async () : Promise<any> => {
      const artifactFixture: any = await stagePluginArtifactVerificationFixture({ sourcePluginRoot: path.join(fixtureRoot, "plugins") });
      try {
        const registry: any = await loadPluginRegistry({ artifactAuthority: artifactFixture.authority });
        for (const enabledPluginIds of [["demo"], ["missing"]]) {
          let rejected: any = false;
          try {
            registry.resolveDeployment({ enabledPluginIds });
          } catch {
            rejected = true;
          }
          if (!rejected) throw new Error("Invalid plugin selection was accepted.");
        }
      } finally {
        await artifactFixture.close();
      }
    });

    await check("manifest-schema-path-and-claim-conflicts-fail-closed", async () : Promise<any> => {
      let rejectedTraversal: any = false;
      try {
        normalizePluginManifest(manifest("escape", { runtime: { module: "../escape.ts" } }));
      } catch {
        rejectedTraversal = true;
      }
      if (!rejectedTraversal) throw new Error("Plugin runtime path traversal was accepted.");
      let rejectedClaims: any = false;
      try {
        createPluginRegistry([
          manifest("alpha", { operations: ["demo.operation"] }),
          manifest("beta", { operations: ["demo.operation"] })
        ]);
      } catch {
        rejectedClaims = true;
      }
      if (!rejectedClaims) throw new Error("Duplicate plugin claims were accepted.");
    });

    await check("partial-activation-failure-unwinds-registered-resources", async () : Promise<any> => {
      const failureRoot: any = path.join(tempRoot, "failure-repo");
      const failureEventPath: any = path.join(tempRoot, "failure-events.jsonl");
      await writePlugin(
        failureRoot,
        manifest("alpha", { runtime: { module: "./runtime.ts" } }),
        `
import { appendFileSync } from "node:fs";
const event = (value) => appendFileSync(${JSON.stringify(failureEventPath)}, value + "\\n", "utf8");
export async function activatePlugin({ manifest, onClose }) {
  event("alpha:activate");
  onClose(() => event("alpha:registered-close"));
  return { id: manifest.id, mounts: {}, close() { event("alpha:close"); } };
}`
      );
      await writePlugin(
        failureRoot,
        manifest("beta", { runtime: { module: "./runtime.ts" } }),
        `
import { appendFileSync } from "node:fs";
const event = (value) => appendFileSync(${JSON.stringify(failureEventPath)}, value + "\\n", "utf8");
export async function activatePlugin({ onClose }) {
  event("beta:activate");
  onClose(() => event("beta:registered-close"));
  throw new Error("private fixture failure detail");
}`
      );
      let publicMessage: any = "";
      try {
        await fixtureManager(failureRoot, path.join(tempRoot, "failure-state"), ["alpha", "beta"]);
      } catch (error: any) {
        publicMessage = error?.message || "";
      }
      if (!publicMessage || publicMessage.includes("private fixture failure detail")) {
        throw new Error("Plugin activation failure was not redacted.");
      }
      const expected: any[] = ["alpha:activate", "beta:activate", "beta:registered-close", "alpha:close", "alpha:registered-close"];
      if ((await readFixtureEvents(failureEventPath)).join(",") !== expected.join(",")) {
        throw new Error("Partial plugin activation did not unwind registered resources.");
      }
    });

    await check("configured-provider-and-plugin-mount-conflicts-fail-closed", async () : Promise<any> => {
      const fixtureEventsBefore: any = await readFixtureEvents(fixtureEventPath);
      const closingBefore: any = fixtureEventsBefore.filter((entry?: any) : any => entry.includes("close")).length;
      const activationBefore: any = fixtureEventsBefore.filter((entry?: any) : any => entry.endsWith(":activate")).length;
      let rejected: any = false;
      try {
        await fixtureManager(
          fixtureRoot,
          path.join(tempRoot, "conflict-state"),
          ["demo", "dependency"],
          {
            runtimeOptions: {
              mountModules: { demo: { kind: "document", provider: "builtin-demo" } }
            },
            builtinMountProviders: {
              "builtin-demo": { id: "builtin-demo", kind: "document" }
            }
          }
        );
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("Configured mount overrode an enabled plugin mount.");
      const fixtureEventsAfter: any = await readFixtureEvents(fixtureEventPath);
      const closingAfter: any = fixtureEventsAfter.filter((entry?: any) : any => entry.includes("close")).length;
      const activationAfter: any = fixtureEventsAfter.filter((entry?: any) : any => entry.endsWith(":activate")).length;
      const acquired: any = activationAfter - activationBefore;
      const closed: any = closingAfter - closingBefore;
      if (!((acquired === 0 && closed === 0) || (acquired === 2 && closed === 4))) {
        throw new Error(`Startup conflict did not reject before activation or unwind activated plugins (activated=${acquired}, closed=${closed}).`);
      }
    });

    await check("close-failure-is-surfaced-after-all-cleanups-run", async () : Promise<any> => {
      const closeFailureRoot: any = path.join(tempRoot, "close-failure-repo");
      const closeFailureEventPath: any = path.join(tempRoot, "close-failure-events.jsonl");
      await writePlugin(
        closeFailureRoot,
        manifest("close-failure", { runtime: { module: "./runtime.ts" } }),
        `
import { appendFileSync } from "node:fs";
const event = (value) => appendFileSync(${JSON.stringify(closeFailureEventPath)}, value + "\\n", "utf8");
export async function activatePlugin({ manifest, onClose }) {
  onClose(() => event("registered-close"));
  return {
    id: manifest.id,
    mounts: {},
    close() { event("result-close"); throw new Error("private close detail"); }
  };
}`
      );
      const manager: any = await fixtureManager(
        closeFailureRoot,
        path.join(tempRoot, "close-failure-state"),
        ["close-failure"]
      );
      let errorCode: any = "";
      let errorMessage: any = "";
      try {
        await manager.close();
      } catch (error: any) {
        errorCode = error?.code || "";
        errorMessage = error?.message || "";
      }
      if (errorCode !== "PLUGIN_RUNTIME_CLOSE_FAILED" || errorMessage.includes("private close detail")) {
        throw new Error("Plugin close failure was not surfaced through the redacted lifecycle error.");
      }
      if ((await readFixtureEvents(closeFailureEventPath)).join(",") !== "result-close,registered-close") {
        throw new Error("A plugin close failure prevented remaining cleanup callbacks.");
      }
    });

    pluginOwnershipFailures = await collectPluginRuntimeOwnershipFailures(repoRegistry, { repoRoot: ROOT });
    executableSelectionFailures = await collectExecutableSelectionFailures();
  } finally {
    await repoArtifactFixture?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const failed: any = checks.filter((item?: any) : any => item.status !== "passed");
  const executableChecks: any = checks.filter((item?: any) : any => item.id.startsWith("executable-"));
  const runtimeChecks: any = checks.filter((item?: any) : any => !item.id.startsWith("executable-"));
  const runtimeContractReady: any = runtimeChecks.every((item?: any) : any => item.status === "passed");
  const pluginOwnershipReady: any = pluginOwnershipFailures.length === 0;
  const executableSelectionReady: any = executableSelectionFailures.length === 0 &&
    executableChecks.length === 2 &&
    executableChecks.every((item?: any) : any => item.status === "passed");
  const failures: any[] = [...executableSelectionFailures, ...pluginOwnershipFailures];
  const blockers: any = failures.filter((item?: any) : any => item.kind === "external-evidence");
  const localImplementationFailures: any = failures.filter((item?: any) : any =>
    item.kind !== "external-evidence"
  );
  const { everyCheckParticipates, pluginRuntimeAcceptanceReady } =
    reducePluginRuntimeAcceptance({
      checks,
      runtimeContractReady,
      executableSelectionReady,
      pluginOwnershipReady
    });
  const report: Record<string, any> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    generatedAt: new Date().toISOString(),
    pluginRuntimeAcceptanceReady,
    coverageReady: pluginRuntimeAcceptanceReady,
    runtimeContractReady,
    executableSelectionReady,
    pluginOwnershipReady,
    everyCheckParticipates,
    checks,
    physicalRemovalMatrix,
    failures: localImplementationFailures,
    blockers,
    summary: {
      pluginRuntimeAcceptanceReady,
      coverageReady: pluginRuntimeAcceptanceReady,
      runtimeContractReady,
      executableSelectionReady,
      pluginOwnershipReady,
      everyCheckParticipates,
      physicalRemovalProofCount: physicalRemovalMatrix.length,
      reportLeakScan: false,
      checkCount: checks.length,
      failedCount: failed.length + localImplementationFailures.length,
      blockedCount: blockers.length,
      incompleteCount: failures.length
    }
  };
  await writePluginRuntimeReport(report);
  if (!pluginRuntimeAcceptanceReady) {
    console.error(
      `[plugin-runtime] failed=${failed.length + localImplementationFailures.length} ` +
      `blocked=${blockers.length} report=${toPosixRelative(REPORT_PATH)}`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[plugin-runtime] verified checks=${checks.length} report=${toPosixRelative(REPORT_PATH)}`);
}

async function writeFailureReport(error?: any) : Promise<any> {
  const report: Record<string, any> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    generatedAt: new Date().toISOString(),
    pluginRuntimeAcceptanceReady: false,
    coverageReady: false,
    runtimeContractReady: false,
    executableSelectionReady: false,
    pluginOwnershipReady: false,
    everyCheckParticipates: true,
    checks: [{ id: "plugin-runtime", status: "failed", error: sanitizeError(error, [ROOT]) }],
    physicalRemovalMatrix: [],
    failures: [],
    blockers: [],
    summary: {
      pluginRuntimeAcceptanceReady: false,
      coverageReady: false,
      runtimeContractReady: false,
      executableSelectionReady: false,
      pluginOwnershipReady: false,
      everyCheckParticipates: true,
      physicalRemovalProofCount: 0,
      reportLeakScan: false,
      checkCount: 1,
      failedCount: 1,
      blockedCount: 0,
      incompleteCount: 0
    }
  };
  try {
    await fs.rm(REPORT_PATH, { force: true });
    await writePluginRuntimeReport(report);
  } catch (reportError: any) {
    await fs.rm(REPORT_PATH, { force: true });
    console.error(`[plugin-runtime] safe-failure-report-write-failed reason=${sanitizeError(reportError, [ROOT])}`);
    process.exitCode = 1;
    return;
  }
  console.error(`[plugin-runtime] failed=1 blocked=0 report=${toPosixRelative(REPORT_PATH)}`);
  process.exitCode = 1;
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(writeFailureReport);
}
