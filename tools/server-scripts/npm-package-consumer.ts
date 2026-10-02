#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";

const execFileAsync: any = promisify(execFile);
const registry: any = process.env.MESHRIX_NPM_REGISTRY || "";
const reportPath: any = process.env.MESHRIX_NPM_REPORT || "/evidence/consumer-report.json";
const planPath: any = process.env.MESHRIX_NPM_PLAN || "/input/consumer-plan.json";
let npmCli: any = null;
let npmCliUnavailable = false;
function npmInvocation(): any {
  if (npmCli) return npmCli;
  if (npmCliUnavailable) throw new Error("npm_cli_entrypoint_not_found");
  try {
    npmCli = resolveNpmCliInvocation();
  } catch {
    npmCliUnavailable = true;
    throw new Error("npm_cli_entrypoint_not_found");
  }
  return npmCli;
}
const runtimeArchitecture: any = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "other";
const runtimeOs: any = ({ linux: "linux", darwin: "darwin", win32: "windows" } as Record<string, string>)[process.platform] || "other";
const runtimePlatform: any = `${runtimeOs}/${runtimeArchitecture}`;
const requestedPlatform: any = String(process.env.MESHRIX_NPM_PLATFORM || runtimePlatform);
const platform: any = /^(?:linux|darwin|windows|other)\/(?:amd64|arm64|other)$/u.test(requestedPlatform)
  ? requestedPlatform
  : "unknown";
export const NPM_PACKAGE_CONSUMER_FAILURE_CODES: ReadonlySet<string> = new Set([
  "npm_package_module_identity_mismatch",
  "npm_package_module_resolution_failed",
  "npm_package_operator_script_failed",
  "npm_package_mcp_doctor_failed",
  "npm_package_gateway_embed_failed",
  "npm_package_adapter_cli_describe_failed",
  "npm_package_adapter_cli_identity_invalid",
  "npm_package_adapter_cli_missing",
  "npm_package_adapter_cli_version_invalid",
  "npm_package_cli_help_failed",
  "npm_package_cli_offline_interface_failed",
  "npm_package_mcp_identity_invalid",
  "npm_package_mcp_proxy_failed",
  "npm_package_mcp_version_invalid",
  "npm_package_console_asset_empty",
  "npm_package_console_asset_failed",
  "npm_package_console_browser_error",
  "npm_package_console_cross_origin_asset",
  "npm_package_console_css_asset_missing",
  "npm_package_console_html_failed",
  "npm_package_console_js_asset_missing",
  "npm_package_consumer_failed",
  "npm_package_consumer_plan_empty",
  "npm_package_dependency_resolution_failed",
  "npm_cli_entrypoint_not_found",
  "npm_package_install_oom_killed",
  "npm_package_install_permission_denied",
  "npm_package_installed_name_mismatch",
  "npm_package_installed_restore_apply_failed",
  "npm_package_installed_restore_apply_integrity_failed",
  "npm_package_installed_restore_apply_mode_invalid",
  "npm_package_installed_restore_integrity_failed",
  "npm_package_installed_restore_not_applied",
  "npm_package_installed_restore_preview_failed",
  "npm_package_installed_restore_preview_mode_invalid",
  "npm_package_installed_restore_preview_wrote_data",
  "npm_package_installed_version_mismatch",
  "npm_package_native_dependency_build_failed",
  "npm_package_offline_cache_incomplete",
  "npm_package_registry_unreachable",
  "npm_package_registry_package_missing",
  "npm_package_server_bootstrap_failed",
  "npm_package_server_cli_help_failed",
  "npm_package_server_exited",
  "npm_package_server_health_failed",
  "npm_package_server_shutdown_failed",
  "npm_package_ui_browser_error",
  "npm_package_ui_build_javascript_missing",
  "npm_package_ui_build_stylesheet_missing",
  "npm_package_ui_cross_origin_asset",
  "npm_package_ui_interactive_export_missing",
  "npm_package_ui_preview_exited",
  "npm_package_ui_styles_export_missing"
]);
export const NPM_PACKAGE_CONSUMER_FAILURE_STAGES: ReadonlySet<string> = new Set([
  "adapter_cli",
  "container_runtime",
  "consumer_report_validation",
  "installed_manifest",
  "installed_runtime",
  "npm_install",
  "runtime_exports",
  "schema_worker",
  "ui_browser",
  "module_identity",
  "operator_scripts",
  "gateway_embed",
  "package_types",
  "plan_loading"
]);

export function consumerFailureSummary(error?: any) : Record<string, any> {
  const message: any = typeof error?.message === "string" ? error.message : "";
  if (NPM_PACKAGE_CONSUMER_FAILURE_CODES.has(message)) {
    return { success: false, errorCode: message };
  }

  const output: any = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
  const classifiers: any[] = [
    [/ERR_PACKAGE_IMPORT_NOT_DEFINED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/iu, "npm_package_module_resolution_failed"],
    [/ENOTCACHED|cache mode is ['"]?only-if-cached/iu, "npm_package_offline_cache_incomplete"],
    [/node-gyp|gyp ERR|Could not locate the bindings file/iu, "npm_package_native_dependency_build_failed"],
    [/EACCES|permission denied/iu, "npm_package_install_permission_denied"],
    [/npm (?:error|ERR!) code ERESOLVE/iu, "npm_package_dependency_resolution_failed"],
    [/npm (?:error|ERR!) code E404/iu, "npm_package_registry_package_missing"],
    [/ETIMEDOUT|ENETUNREACH|EAI_AGAIN/iu, "npm_package_registry_unreachable"]
  ];
  const classified: any = classifiers.find(([pattern]: any[]) : any => pattern.test(output))?.[1];
  return { success: false, errorCode: classified || "npm_package_consumer_failed" };
}

let activeFailureStage: any = "plan_loading";
let activeFailurePackageIndex: any = -1;
const report: Record<string, any> = {
  platform,
  runtime: { platform: runtimeOs, architecture: runtimeArchitecture, nodeVersion: process.version },
  consumers: [],
  failures: [],
  cli: {},
  server: {},
  sqlite: {},
  migrations: {},
  schemaWorker: {},
  offlineRestore: {},
  browser: {}
};

function exportEntries(manifest?: any) : any[] {
  const field: any = manifest?.exports;
  if (typeof field === "string") return [{ subpath: ".", target: field }];
  if (!field || typeof field !== "object" || Array.isArray(field)) return [];
  const keys: any[] = Object.keys(field);
  const subpathMap: any = keys.some((key?: any) : any => key === "." || key.startsWith("./"));
  return (subpathMap ? Object.entries(field) : [[".", field]])
    .filter(([, target]: any[]) : any => target !== null && target !== false)
    .map(([subpath, target]: any[]) : any => ({ subpath, target }));
}

function conditionalTarget(target?: any, types = false) : any {
  if (typeof target === "string") return types && /\.css$/iu.test(target) ? "" : target;
  if (Array.isArray(target)) return target.map((item?: any) : any => conditionalTarget(item, types)).find(Boolean) || "";
  if (!target || typeof target !== "object") return "";
  const conditions: any[] = types ? ["types"] : ["import", "node", "default"];
  for (const condition of conditions) {
    if (Object.hasOwn(target, condition)) {
      const selected: any = conditionalTarget(target[condition], types);
      if (selected) return selected;
    }
  }
  return "";
}

function publicEntries(manifest?: any) : any[] {
  const packageName: any = String(manifest?.name || "");
  return exportEntries(manifest).map(({ subpath, target }: Record<string, any>) : any => {
    const specifier: any = subpath === "." ? packageName : `${packageName}/${String(subpath).slice(2)}`;
    return {
      subpath,
      specifier,
      runtimeTarget: conditionalTarget(target),
      typeTarget: conditionalTarget(target, true)
    };
  });
}

export function packageTypeSpecifiers(manifest?: any) : string[] {
  const entries: any[] = publicEntries(manifest).filter((entry?: any) : any => Boolean(entry.typeTarget));
  if (!manifest?.exports && entries.length === 0 && (manifest?.types || manifest?.typings)) return [manifest.name];
  if (!manifest?.exports && entries.length === 0) return [];
  if (manifest?.types || manifest?.typings) {
    const root: any = entries.find((entry?: any) : any => entry.specifier === manifest.name);
    if (root && !root.typeTarget) root.typeTarget = manifest.types || manifest.typings;
  }
  return entries.map((entry?: any) : any => entry.specifier);
}

function packageRuntimeSpecifiers(manifest?: any) : string[] {
  return publicEntries(manifest)
    .filter(({ runtimeTarget }: Record<string, any>) : any => runtimeTarget && !/\.(?:css|vue|d\.ts)$/iu.test(runtimeTarget))
    .map(({ specifier }: Record<string, any>) : any => specifier);
}


function npmCommand() : any {
  return npmInvocation().command;
}

function npmEnv(overrides: Record<string, any> = {}) : any {
  return {
    ...Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"]
      .filter((name?: any) : any => process.env[name])
      .map((name?: any) : any => [name, process.env[name]])),
    HOME: process.env.HOME || "/tmp/home",
    USERPROFILE: process.env.USERPROFILE || process.env.HOME || "/tmp/home",
    TMPDIR: process.env.TMPDIR || "/tmp",
    TEMP: process.env.TEMP || process.env.TMPDIR || "/tmp",
    TMP: process.env.TMP || process.env.TMPDIR || "/tmp",
    MESHRIX_USER_DATA_DIR: process.env.MESHRIX_USER_DATA_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    npm_config_userconfig: process.env.npm_config_userconfig,
    npm_config_cache: process.env.npm_config_cache,
    npm_config_registry: registry,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "false",
    ...(process.env.npm_config_nodedir ? { npm_config_nodedir: process.env.npm_config_nodedir } : {}),
    npm_config_jobs: "1",
    MAKEFLAGS: "-j1",
    CFLAGS: "-O1 -g0",
    CXXFLAGS: "-O1 -g0",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    NODE_OPTIONS: "",
    ...overrides
  };
}

async function launchBrowser(toolsDirectory: string) : Promise<any> {
  const toolRequire = createRequire(path.join(toolsDirectory, "package.json"));
  const { chromium } = toolRequire("@playwright/test");
  return chromium.launch({
    executablePath: process.env.MESHRIX_CHROMIUM_EXECUTABLE || chromium.executablePath(),
    env: { ...process.env, HOME: process.env.HOME || "/tmp/home", XDG_RUNTIME_DIR: process.env.TMPDIR || "/tmp" },
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crashpad", "--disable-crash-reporter"]
  });
}

async function run(command?: any, args?: any[], cwd?: any, environment?: any, input?: string) : Promise<any> {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: environment || npmEnv(),
    input
  });
}

async function npm(args?: any[], cwd?: any, environment?: any, input?: string) : Promise<any> {
  return run(npmCommand(), npmCliArgs(npmInvocation(), args), cwd, environment || npmEnv(), input);
}

async function installConsumer({ record, base, typeTools, vueTools, onStage = () => {} }: Record<string, any>) : Promise<any> {
  const consumerDirectory: any = path.join(base, record.root ? "meshrix-root-consumer" : `leaf-${safeName(record.name)}`);
  const devDependencies: Record<string, any> = record.root
    ? vueTools
    : typeTools && record.hasTypes
      ? { typescript: typeTools.typescript, "@types/node": typeTools.node }
      : {};
  onStage("npm_install");
  await fs.mkdir(consumerDirectory, { recursive: true });
  await fs.writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: `meshrix-consumer-${safeName(record.name)}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [record.name]: record.version },
    allowScripts: record.root ? { "better-sqlite3": true } : {},
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
  }, null, 2)}\n`, "utf8");
  await npm(["install", "--no-audit", "--no-fund", "--registry", registry], consumerDirectory);
  onStage("installed_manifest");
  const packageManifestPath: any = path.join(consumerDirectory, "node_modules", record.name, "package.json");
  const installedManifest: any = JSON.parse(await fs.readFile(packageManifestPath, "utf8"));
  assert.equal(installedManifest.name, record.name, "npm_package_installed_name_mismatch");
  assert.equal(installedManifest.version, record.version, "npm_package_installed_version_mismatch");
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(consumerDirectory, "package.json"), "utf8")).dependencies), [record.name]);

  const runtimeSpecifiers: string[] = packageRuntimeSpecifiers(installedManifest);
  const runtimeProbePath: any = path.join(consumerDirectory, "meshrix-runtime-exports.mjs");
  {
    onStage("runtime_exports");
    await fs.writeFile(runtimeProbePath, `for (const specifier of ${JSON.stringify(runtimeSpecifiers)}) await import(specifier);\n`, "utf8");
    if (runtimeSpecifiers.length > 0) await run(process.execPath, [runtimeProbePath], consumerDirectory, npmEnv());
  }

  const typeSpecifiers: string[] = packageTypeSpecifiers(installedManifest);
  if (typeSpecifiers.length > 0) {
    onStage("package_types");
    const imports: any = typeSpecifiers.map((specifier?: any, index?: any) : any => `import type * as PublicEntry${index} from ${JSON.stringify(specifier)};`).join("\n");
    const publicTypeProbe: any = path.join(consumerDirectory, "meshrix-public-entries.ts");
    await fs.writeFile(publicTypeProbe, `${imports}\nexport type PublicEntries = [${typeSpecifiers.map((_specifier?: any, index?: any) : any => `typeof PublicEntry${index}`).join(", ")}];\n`, "utf8");
    const typeScript: any = path.join(consumerDirectory, "node_modules", "typescript", "bin", "tsc");
    await fs.access(typeScript);
    await run(process.execPath, [typeScript, "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--noEmit", "--skipLibCheck", publicTypeProbe], consumerDirectory, npmEnv());
  }

  const result: Record<string, any> = {
    name: record.name,
    version: record.version,
    directDependencyOnly: true,
    consumerKind: record.root ? "platform" : "gateway",
    runtimeExportCount: runtimeSpecifiers.length,
    typeExportCount: typeSpecifiers.length,
    installLifecycleCompleted: true
  };
  if (record.root) {
    const installedRoot = path.dirname(packageManifestPath);
    onStage("module_identity");
    result.moduleIdentity = await verifyInstalledModuleIdentity(installedRoot);
    onStage("adapter_cli");
    await runInstalledAdapterDescriptions({ cwd: consumerDirectory, installedRoot, rootManifest: installedManifest });
    onStage("ui_browser");
    const uiManifest = JSON.parse(await fs.readFile(path.join(installedRoot, "node_modules/@meshrix/ui-console/package.json"), "utf8"));
    const uiDirectory = path.join(installedRoot, ".verification-ui");
    await fs.mkdir(uiDirectory, { recursive: true });
    result.browser = await runVueBrowserConsumer({ manifest: uiManifest, cwd: uiDirectory, toolsDirectory: consumerDirectory });
    onStage("installed_runtime");
    await runRootRuntimeConsumer({ cwd: consumerDirectory, rootManifest: installedManifest, onStage });
  }
  if (record.name === "@meshrix/gateway") {
    onStage("schema_worker");
    await runSchemaWorkerProbe({ cwd: consumerDirectory });
    onStage("gateway_embed");
    result.embeddedExamples = await runGatewayExamples(consumerDirectory);
  }
  return result;
}

function safeName(value?: any) : any {
  return String(value || "package").replace(/^@/u, "").replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

/** Check actual Node resolution without a custom loader or rewritten package metadata. */
export async function verifyInstalledModuleIdentity(installedRoot: string): Promise<{ aliasCount: number; componentCount: number; sharedRegistry: boolean }> {
  const rootManifest = JSON.parse(await fs.readFile(path.join(installedRoot, "package.json"), "utf8"));
  const rootRequire = createRequire(path.join(installedRoot, "package.json"));
  let aliasCount = 0;
  const components: string[] = rootManifest.bundleDependencies || [];
  for (const directory of [installedRoot, ...components.map((name) => path.join(installedRoot, "node_modules", name))]) {
    const manifestPath = path.join(directory, "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const ownerRequire = createRequire(manifestPath);
    for (const [alias, target] of Object.entries(manifest.imports || {}) as [string, any][]) {
      const rootTarget = rootManifest.imports?.[alias];
      const rootDefault = typeof rootTarget === "string" ? rootTarget : rootTarget?.default;
      const canonical = typeof rootDefault === "string" && rootDefault.startsWith("@meshrix/")
        ? rootDefault
        : typeof target === "string" ? target : target?.default;
      if (typeof canonical !== "string" || !canonical.startsWith("@meshrix/")) continue;
      assert.equal(ownerRequire.resolve(alias), rootRequire.resolve(canonical), "npm_package_module_identity_mismatch");
      aliasCount += 1;
    }
  }
  const registry = "@meshrix/foundation/security/authorization/tag-store-provider-registry";
  const viaRoot = await import(pathToFileURL(rootRequire.resolve(registry)).href);
  const runtimeRequire = createRequire(path.join(installedRoot, "node_modules/@meshrix/server-runtime/package.json"));
  const viaRuntime = await import(pathToFileURL(runtimeRequire.resolve("#meshrix/foundation/security/authorization/tag-store-provider-registry")).href);
  assert.equal(viaRoot, viaRuntime, "npm_package_module_identity_mismatch");
  return { aliasCount, componentCount: components.length, sharedRegistry: true };
}

async function runInstalledAdapterDescriptions({ cwd, installedRoot, rootManifest }: Record<string, any>): Promise<void> {
  const rootRequire = createRequire(path.join(installedRoot, "package.json"));
  const connectorRoot = path.dirname(path.dirname(rootRequire.resolve("@meshrix/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp")));
  const probe = path.join(cwd, "meshrix-adapter-probe.mjs");
  await fs.writeFile(probe, `import assert from "node:assert/strict";
import { describeClientAdapter } from ${JSON.stringify(pathToFileURL(path.join(connectorRoot, "lib/cli/client-adapter-runner.js")).href)};
import { MCP_SUPPORTED_TARGETS } from ${JSON.stringify(pathToFileURL(path.join(connectorRoot, "mcp-release-targets.js")).href)};
for (const target of MCP_SUPPORTED_TARGETS) {
  const described = await describeClientAdapter({ target });
  assert.equal(described.result.target, target);
}
process.stdout.write(JSON.stringify({ count: MCP_SUPPORTED_TARGETS.length }));
`, "utf8");
  const result = JSON.parse((await run(process.execPath, [probe], cwd, npmEnv())).stdout);
  assert.equal(result.count, 7, "npm_package_adapter_cli_describe_failed");
  report.cli.adapterDescribeCount = result.count;
}

async function runRootRuntimeConsumer({ cwd, rootManifest, onStage = () => {} }: Record<string, any>) : Promise<void> {
  const runInstalled: any = async (name?: any, args: any[] = []) : Promise<any> => npm(["exec", "--offline", "--", name, ...args], cwd);
  const help: any = await runInstalled("meshrix", ["--help"]);
  assert.match(help.stdout, /Usage:/u, "npm_package_cli_help_failed");
  const interfaces: any = await runInstalled("meshrix", ["interfaces", "--format", "markdown"]);
  assert.match(interfaces.stdout, /jobs\.list/u, "npm_package_cli_offline_interface_failed");
  const serverHelp: any = await runInstalled("meshrix-server", ["--help"]);
  assert.match(serverHelp.stdout, /--with-ui/u, "npm_package_server_cli_help_failed");
  const explicitPackageBin: any = await npm([
    "exec",
    "--yes",
    "--package",
    `${rootManifest.name}@${rootManifest.version}`,
    "--",
    "meshrix-mcp",
    "version",
    "--json"
  ], cwd, npmEnv());
  const mcpPayload: any = JSON.parse(explicitPackageBin.stdout);
  assert.equal(mcpPayload.packageName, rootManifest.name, "npm_package_mcp_identity_invalid");
  assert.equal(mcpPayload.packageVersion, rootManifest.version, "npm_package_mcp_version_invalid");
  const mcpHelp: any = await runInstalled("meshrix-mcp", ["help"]);
  assert.match(mcpHelp.stdout, /Usage:/u, "npm_package_cli_help_failed");
  onStage("operator_scripts");
  const installedRoot = path.join(cwd, "node_modules", rootManifest.name);
  const runOperatorScript: any = async (name?: any, args: any[] = [], environment: Record<string, any> = {}) : Promise<any> => {
    try {
      return await npm(["run", "--silent", name, "--", ...args], installedRoot, npmEnv(environment));
    } catch {
      throw new Error("npm_package_operator_script_failed");
    }
  };
  const serverStartHelp: any = await runOperatorScript("server:start", ["--help"]);
  assert.match(serverStartHelp.stdout, /--with-ui/u, "npm_package_operator_script_failed");
  assert.match(serverStartHelp.stdout, /--edition/u, "npm_package_operator_script_failed");
  const authHelp: any = await runOperatorScript("server:auth", ["--help"]);
  assert.match(authHelp.stdout, /Console Auth/u, "npm_package_operator_script_failed");
  const rotateHelp: any = await runOperatorScript("server:auth:rotate", ["--help"]);
  assert.match(rotateHelp.stdout, /Console Auth/u, "npm_package_operator_script_failed");
  const installerVersion = JSON.parse((await runInstalled("meshrix-mcp", ["version", "--json"])).stdout);
  assert.equal(installerVersion.packageName, rootManifest.name, "npm_package_operator_script_failed");
  assert.equal(installerVersion.packageVersion, rootManifest.version, "npm_package_operator_script_failed");

  const operatorData = path.join(cwd, ".verification-operator-data");
  await fs.mkdir(operatorData, { recursive: true });
  const doctorOutput: any = await runOperatorScript("server:doctor", ["--data-dir", operatorData]);
  const doctorReport: any = JSON.parse(doctorOutput.stdout);
  assert.equal(typeof doctorReport.databasePresent, "boolean", "npm_package_operator_script_failed");
  const locateOutput: any = await runOperatorScript("server:locate", ["--data-dir", operatorData, "--object-id", "unpublished-probe"]);
  const locateReport: any = JSON.parse(locateOutput.stdout);
  assert.equal(locateReport.query.objectId, "unpublished-probe", "npm_package_operator_script_failed");
  const reconcileOutput: any = await runOperatorScript("server:reconcile", ["--data-dir", operatorData]);
  const reconcileReport: any = JSON.parse(reconcileOutput.stdout);
  assert.equal(reconcileReport.apply, false, "npm_package_operator_script_failed");
  report.cli.operatorScripts = {
    packagedServerStart: true,
    consoleAuthHelp: true,
    consoleAuthRotateHelp: true,
    mcpRootBinVersion: true,
    storageDoctor: true,
    storageLocate: true,
    storageReconcileDryRun: true
  };
  onStage("installed_runtime");
  report.cli = {
    ...report.cli,
    help: true,
    offlineInterfaceCatalog: true,
    serverHelp: true,
    mcpHelp: true,
    mcpVersion: true,
    explicitRootPackageBin: true,
    publicServerBin: true,
    standaloneConnectorPackage: false
  };

  await runInstalledMcpProxy({ cwd, rootManifest });

  const testData: any = path.join(process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data", "sqlite-consumer");
  await fs.mkdir(testData, { recursive: true });
  const sqliteProbe: any = path.join(cwd, "meshrix-sqlite-probe.mjs");
  await fs.writeFile(sqliteProbe, `import assert from "node:assert/strict";\nimport { createRequire } from "node:module";\nimport { pathToFileURL } from "node:url";\nconst require = createRequire(pathToFileURL(${JSON.stringify(path.join(cwd, "package.json"))}));\nconst Database = require("better-sqlite3");\nconst db = new Database(${JSON.stringify(path.join(testData, "native.sqlite"))});\ndb.exec("CREATE TABLE runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");\ndb.prepare("INSERT INTO runtime_probe (value) VALUES (?)").run("installed-native-sqlite");\nassert.equal(db.prepare("SELECT value FROM runtime_probe WHERE id = 1").get().value, "installed-native-sqlite");\ndb.close();\n`, "utf8");
  await run(process.execPath, [sqliteProbe], cwd, npmEnv());
  report.sqlite = { installedNativeBindingLoaded: true, insertSelectRoundTrip: true };

  const migrationProbe: any = path.join(cwd, "node_modules", rootManifest.name, ".verification-migration.mjs");
  await fs.writeFile(migrationProbe, `import assert from "node:assert/strict";\nimport { createRequire } from "node:module";\nimport { pathToFileURL } from "node:url";\nimport { runMigrations } from "@meshrix/foundation/storage/sqlite-migrations";\nconst require = createRequire(pathToFileURL(${JSON.stringify(path.join(cwd, "package.json"))}));\nconst Database = require("better-sqlite3");\nconst db = new Database(${JSON.stringify(path.join(testData, "migration.sqlite"))});\nrunMigrations(db, [{ version: 1, up: (database) => database.exec("CREATE TABLE migration_probe (value TEXT NOT NULL)") }, { version: 2, up: (database) => database.prepare("INSERT INTO migration_probe (value) VALUES (?)").run("packaged-migration") }]);\nassert.equal(db.pragma("user_version", { simple: true }), 2);\nassert.equal(db.prepare("SELECT value FROM migration_probe").get().value, "packaged-migration");\nrunMigrations(db, [{ version: 1, up: () => { throw new Error("applied migration reran"); } }, { version: 2, up: () => { throw new Error("applied migration reran"); } }]);\nassert.equal(db.pragma("user_version", { simple: true }), 2);\ndb.close();\n`, "utf8");
  await run(process.execPath, [migrationProbe], cwd, npmEnv());
  report.migrations = { packagedRunner: true, orderedTransactions: true, schemaVersionPersisted: true, appliedVersionsAreIdempotent: true };

  await runInstalledOfflineRestore({ cwd, testData, installedRoot: path.join(cwd, "node_modules", rootManifest.name) });

  await runPackagedServerUi({ cwd, rootManifest, onStage });
}

export async function runInstalledMcpProxy({ cwd, rootManifest }: Record<string, any>) : Promise<Record<string, any>> {
  const token: any = `mxak1.${randomBytes(18).toString("base64url").slice(0, 22)}.${randomBytes(36).toString("base64url").slice(0, 43)}`;
  const observed: Record<string, any> = {
    discovery: false,
    doctor: false,
    notification: false,
    signedDiscovery: false,
    toolsList: false,
    toolsCall: false,
    packageIdentity: false,
    tokenHeader: false,
    targetHeader: false,
    errors: []
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const identity = { keyId: "synthetic-installed-peer", publicKeyJwk: { crv: jwk.crv, kty: jwk.kty, x: jwk.x } };
  const serverInfo = {
    interfaceVersion: "v0.0.1:mcp:interface-1",
    name: "Meshrix.js",
    serverId: "synthetic-mcp-peer",
    serverVersion: "1.0.0",
    stableToolName: "meshrix.discovery",
    toolsetVersion: "v0.0.1:mcp:toolset-1"
  };
  const canonicalJson = (value: any): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  };
  const respond = (response: any, payload: unknown) => {
    const body = JSON.stringify(payload);
    response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    response.end(body);
  };
  const peer: any = createServer(async (request?: any, response?: any) : Promise<void> => {
    if (request.url === "/api/mcp/discovery" && request.method === "GET") {
      respond(response, { ...serverInfo, identity: { algorithm: "Ed25519", ...identity }, handshake: { url: "/api/mcp/handshake" } });
      return;
    }
    if (request.url === "/api/mcp/handshake" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // The synthetic peer signs the protocol's canonical JSON, independent of the client.
      const baseUrl = `http://127.0.0.1:${request.socket.localPort}`;
      const payload = {
        schemaVersion: "v0.0.1:mcp:handshake-1",
        nonce: input.nonce,
        identity: {
          schemaVersion: "v0.0.1:mcp:identity-1",
          algorithm: "Ed25519",
          ...identity
        },
        server: {
          name: "Meshrix.js",
          serverId: serverInfo.serverId,
          serverVersion: serverInfo.serverVersion,
          interfaceVersion: serverInfo.interfaceVersion,
          toolsetVersion: serverInfo.toolsetVersion,
          stableToolName: serverInfo.stableToolName
        },
        endpoints: {
          baseUrl,
          mcpUrl: `${baseUrl}/mcp`,
          discoveryUrl: `${baseUrl}/api/mcp/discovery`,
          wellKnownUrl: `${baseUrl}/.well-known/meshrix/mcp.json`,
          vmMcpUrl: `${baseUrl}/mcp`
        },
        sharedHub: null
      };
      respond(response, {
        ok: true,
        payload,
        signature: {
          algorithm: "Ed25519",
          payloadEncoding: "v0.0.1:platform:stable-json-1",
          value: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url")
        }
      });
      observed.signedDiscovery = true;
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let message: any;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      observed.errors.push("request_json_invalid");
      response.writeHead(400).end();
      return;
    }
    observed.tokenHeader ||= request.headers["x-meshrix.js-api-key"] === token;
    observed.targetHeader ||= request.headers["x-meshrix.js-mcp-target"] === "opencode";
    const clientInfo: any = message?.params?._meta?.["io.modelcontextprotocol/clientInfo"];
    observed.packageIdentity ||= clientInfo?.name === rootManifest.name && clientInfo?.version === rootManifest.version;
    let result: any = {};
    if (message?.method === "server/discover") {
      observed.discovery = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28"
        && request.headers["mcp-protocol-version"] === "2026-07-28";
      result = {
        capabilities: { tools: { listChanged: true } },
        supportedVersions: ["2026-07-28"],
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: serverInfo.name, version: serverInfo.serverVersion },
          interfaceVersion: serverInfo.interfaceVersion,
          stableToolName: serverInfo.stableToolName
        }
      };
    } else if (message?.method === "notifications/roots/list_changed") {
      observed.notification = true;
      response.writeHead(202).end();
      return;
    } else if (message?.method === "tools/list") {
      observed.toolsList = true;
      result = { tools: [{ name: "meshrix.probe", inputSchema: { type: "object" } }] };
    } else if (message?.method === "tools/call") {
      observed.toolsCall = message.params?.name === "meshrix.probe"
        && message.params?.arguments?.value === "installed-root";
      result = {
        content: [{ type: "text", text: "proxy-ok" }],
        structuredContent: { value: "installed-root" }
      };
    } else {
      observed.errors.push("unexpected_mcp_method");
      response.writeHead(400).end();
      return;
    }
    const body: any = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    response.end(body);
  });
  await new Promise<void>((resolve?: any, reject?: any) : void => {
    peer.once("error", reject);
    peer.listen(0, "127.0.0.1", resolve);
  });
  const address: any = peer.address();
  assert.ok(address && typeof address === "object" && address.port > 0, "npm_package_mcp_proxy_failed");
  const baseUrl: any = `http://127.0.0.1:${address.port}`;
  const proxyHome = path.join(cwd, ".verification-mcp-home");
  await fs.mkdir(proxyHome, { recursive: true });
  const doctor: any = await npm([
    "exec", "--offline", "--", "meshrix-mcp", "doctor", "--url", baseUrl, "--json"
  ], cwd, npmEnv({ HOME: proxyHome, USERPROFILE: proxyHome, MESHRIX_USER_DATA_DIR: path.join(proxyHome, "data") }));
  const doctorReport: any = JSON.parse(doctor.stdout);
  assert.equal(doctorReport.ok, true, "npm_package_mcp_doctor_failed");
  assert.equal(doctorReport.packageName, rootManifest.name, "npm_package_mcp_doctor_failed");
  observed.doctor = true;
  const child: any = spawn(npmCommand(), npmCliArgs(npmInvocation(), ["exec", "--offline", "--", "meshrix-mcp", "proxy", "--target", "opencode", "--url", baseUrl]), {
    cwd,
    env: npmEnv({
      HOME: proxyHome,
      USERPROFILE: proxyHome,
      CODEX_HOME: path.join(proxyHome, "codex"),
      MESHRIX_MCP_TOKEN: token,
      MESHRIX_USER_DATA_DIR: path.join(proxyHome, "data")
    }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.resume();
  let output: any = Buffer.alloc(0);
  const pending = new Map<any, any>();
  const processClose: Promise<any> = new Promise((resolve?: any, reject?: any) : void => {
    child.once("error", () => resolve({ code: null, signal: null, spawnFailed: true }));
    child.once("close", (code?: any, signal?: any) : any => resolve({ code, signal }));
  });
  child.stdout.on("data", (chunk?: any) : void => {
    output = Buffer.concat([output, Buffer.from(chunk)]);
    while (true) {
      const newline: any = output.indexOf("\n");
      if (newline < 0) return;
      const line: any = output.subarray(0, newline).toString("utf8").trim();
      output = output.subarray(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        for (const waiter of pending.values()) waiter.reject(new Error("npm_package_mcp_proxy_failed"));
        pending.clear();
        continue;
      }
      const waiter: any = pending.get(String(message?.id));
      if (waiter) {
        pending.delete(String(message.id));
        waiter.resolve(message);
      }
    }
  });
  child.on("close", (code?: any) : void => {
    if (pending.size > 0) {
      for (const waiter of pending.values()) waiter.reject(new Error("npm_package_mcp_proxy_failed"));
      pending.clear();
    }
  });
  const request = (message?: any) : Promise<any> => new Promise((resolve?: any, reject?: any) : void => {
    const key: any = String(message.id);
    pending.set(key, { resolve, reject });
    child.stdin.write(`${JSON.stringify(message)}\n`, (error?: any) : void => {
      if (error) {
        pending.delete(key);
        reject(new Error("npm_package_mcp_proxy_failed"));
      }
    });
  });
  let closed = false;
  try {
    const discovery: any = await request({
      jsonrpc: "2.0", id: 1, method: "server/discover", params: {}
    });
    assert.equal(discovery.error, undefined, "npm_package_mcp_proxy_failed");
    assert.equal(discovery.result?.capabilities?.tools?.listChanged, true, "npm_package_mcp_proxy_failed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" })}\n`);
    const listed: any = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.result?.tools?.[0]?.name, "meshrix.probe", "npm_package_mcp_proxy_failed");
    const called: any = await request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "meshrix.probe", arguments: { value: "installed-root" } }
    });
    assert.equal(called.result?.structuredContent?.value, "installed-root", "npm_package_mcp_proxy_failed");
    assert.deepEqual(observed.errors, [], "npm_package_mcp_proxy_failed");
    assert.deepEqual(observed, {
      discovery: true,
      doctor: true,
      notification: true,
      signedDiscovery: true,
      toolsList: true,
      toolsCall: true,
      packageIdentity: true,
      tokenHeader: true,
      targetHeader: true,
      errors: []
    }, "npm_package_mcp_proxy_failed");
    child.stdin.end();
    const closeResult: any = await processClose;
    closed = true;
    assert.equal(closeResult.code, 0, "npm_package_mcp_proxy_failed");
    assert.equal(closeResult.signal, null, "npm_package_mcp_proxy_failed");
    report.mcp = {
      installedRootBin: true,
      doctor: true,
      standardDiscovery: true,
      currentProtocolMetadata: true,
      signedPeerVerified: true,
      notificationForwarded: true,
      toolsListed: true,
      representativeProxyCall: true,
      rootPackageIdentityForwarded: true,
      credentialForwardedFromEnvironment: true,
      processClosedCleanly: true
    };
    return report.mcp;
  } finally {
    if (!closed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve?: any) : any => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () : any => resolve());
    });
    await new Promise<void>((resolve?: any, reject?: any) : any => peer.close((error?: any) : any => error ? reject(error) : resolve()));
  }
}

async function runInstalledOfflineRestore({ cwd, testData, installedRoot }: Record<string, any>) : Promise<void> {
  const sourceRoot: any = path.join(testData, "restore-source");
  const backupRoot: any = path.join(testData, "restore-backups");
  const targetRoot: any = path.join(testData, "restore-target");
  const targetCustodyFile: any = path.join(targetRoot, "secrets", "values", "restore-custody.json");
  await fs.mkdir(path.dirname(targetCustodyFile), { recursive: true });
  await fs.writeFile(targetCustodyFile, "{\"custody\":\"preserve\"}\n", "utf8");

  const setupPath: any = path.join(installedRoot, ".verification-restore-setup.mjs");
  await fs.writeFile(setupPath, `import assert from "node:assert/strict";\nimport { createStorageKernel } from "@meshrix/foundation/storage/storage-kernel";\nimport { createStorageProvider } from "@meshrix/foundation/storage/storage-provider";\nconst sourceRoot = ${JSON.stringify(sourceRoot)};\nconst kernel = createStorageKernel({ userDataPath: sourceRoot });\nkernel.close();\nconst provider = createStorageProvider({ userDataPath: sourceRoot });\nconst backup = await provider.createBackup({ label: "npm-candidate-installed-restore" });\nassert.match(backup.backupId, /^backup_[A-Za-z0-9_.-]+$/u);\nprocess.stdout.write(JSON.stringify({ backupId: backup.backupId }));\n`, "utf8");
  const restoreEnv: any = npmEnv({
    MESHRIX_BACKUP_ROOT: backupRoot,
    MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT: "1"
  });
  const setup: any = await run(process.execPath, [setupPath], cwd, restoreEnv);
  const { backupId }: Record<string, any> = JSON.parse(setup.stdout);
  const restoreArgs: any[] = ["storage", "restore", "--data-dir", targetRoot, "--backup-id", backupId];
  const preview: any = await npm(["exec", "--offline", "--", "meshrix", ...restoreArgs], cwd, restoreEnv);
  const previewResult: any = JSON.parse(preview.stdout);
  assert.equal(previewResult.ok, true, "npm_package_installed_restore_preview_failed");
  assert.equal(previewResult.result.mode, "preview", "npm_package_installed_restore_preview_mode_invalid");
  assert.equal(previewResult.result.integrity.verified, true, "npm_package_installed_restore_integrity_failed");
  assert.equal(previewResult.result.applied, false, "npm_package_installed_restore_preview_wrote_data");
  assert.equal(await fs.stat(path.join(targetRoot, "metadata", "meshrix.sqlite")).then(() => true, () => false), false);

  const applied: any = await npm(["exec", "--offline", "--", "meshrix", ...restoreArgs, "--apply", "--confirm"], cwd, restoreEnv);
  const appliedResult: any = JSON.parse(applied.stdout);
  assert.equal(appliedResult.ok, true, "npm_package_installed_restore_apply_failed");
  assert.equal(appliedResult.result.mode, "apply", "npm_package_installed_restore_apply_mode_invalid");
  assert.equal(appliedResult.result.applied, true, "npm_package_installed_restore_not_applied");
  assert.equal(appliedResult.result.integrity.verified, true, "npm_package_installed_restore_apply_integrity_failed");
  assert.equal(await fs.readFile(targetCustodyFile, "utf8"), "{\"custody\":\"preserve\"}\n");
  report.offlineRestore = { installedCli: true, previewReadOnly: true, applyVerified: true, integrityVerified: true, excludedCustodyPreserved: true };
}

async function runGatewayExamples(cwd: string): Promise<{ typed: boolean; executed: number; platformDependenciesAbsent: boolean }> {
  const examples = path.join(cwd, "gateway-examples");
  await fs.cp(path.join(path.dirname(planPath), "gateway-examples"), examples, { recursive: true });
  const sources = (await fs.readdir(examples)).filter((file) => file.endsWith(".ts")).map((file) => path.join(examples, file));
  await run(process.execPath, [path.join(cwd, "node_modules/typescript/bin/tsc"), "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", "gateway-example-dist", ...sources], cwd, npmEnv());
  const expectations: [string, RegExp][] = [
    ["faithful-tool-proxy.js", /kind: 'complete'[\s\S]*value: 'kept'/u],
    ["mrtr-input.js", /kind: 'complete'[\s\S]*accepted/u],
    ["shared-artifact.js", /shared bytes/u]
  ];
  for (const [file, expected] of expectations) {
    const result = await run(process.execPath, [path.join(cwd, "gateway-example-dist", file)], cwd, npmEnv());
    assert.match(result.stdout, expected, "npm_package_gateway_embed_failed");
  }
  const consumerRequire = createRequire(path.join(cwd, "package.json"));
  for (const name of ["@meshrix/foundation", "better-sqlite3", "@meshrix/ui-console"]) {
    assert.throws(() => consumerRequire.resolve(`${name}/package.json`), { code: "MODULE_NOT_FOUND" });
  }
  return { typed: true, executed: expectations.length, platformDependenciesAbsent: true };
}

async function runSchemaWorkerProbe({ cwd }: Record<string, any>) : Promise<void> {
  const schemaWorkerProbe: any = path.join(cwd, "meshrix-schema-worker-probe.mjs");
  await fs.writeFile(schemaWorkerProbe, `import assert from "node:assert/strict";\nimport { createIsolatedSchemaValidator } from "@meshrix/gateway/schema";\nconst validator = createIsolatedSchemaValidator();\ntry {\n  const schema = validator.compile({ type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false });\n  await schema.assertValid({ value: 42 });\n  await assert.rejects(schema.assertValid({ value: "invalid" }), (error) => error?.code === "schema_validation_failed");\n  if (validator.stats().workers < 1) throw new Error("schema worker did not start");\n} finally { await validator.close(); }\nif (validator.stats().workers !== 0) throw new Error("schema worker did not close");\n`, "utf8");
  await run(process.execPath, [schemaWorkerProbe], cwd, npmEnv());
  report.schemaWorker = { installedWorkerEntryLoaded: true, validAndInvalidPayloadsChecked: true, workerClosed: true };
}

function waitForFile(pathValue?: any, child?: any) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    let settled = false;
    const finish: any = (error?: any, value?: any) : any => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      child?.off("exit", onExit);
      error ? reject(error) : resolve(value);
    };
    const onExit: any = () : any => finish(new Error("npm_package_server_exited"));
    const interval: any = setInterval(async () : Promise<void> => {
      try {
        const value: any = JSON.parse(await fs.readFile(pathValue, "utf8"));
        if (value?.status === "ready" && Number(value?.port) > 0) finish(undefined, value);
      } catch (error: any) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) finish(error);
      }
    }, 50);
    child.once("exit", onExit);
  });
}

function childExit(child?: any) : Promise<any> {
  return new Promise((resolve?: any) : any => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once("exit", (code?: any, signal?: any) : any => resolve({ code, signal }));
  });
}

async function request(serverUrl?: any, requestPath?: any) : Promise<any> {
  const response: any = await fetch(new URL(requestPath, serverUrl));
  const body: any = await response.text();
  return { response, body };
}

export async function browserForServer(browser?: any, serverUrl?: any) : Promise<any> {
  const page: any = await browser.newPage();
  const origins: any = new Set();
  page.on("request", (requestValue?: any) : any => origins.add(new URL(requestValue.url()).origin));
  const pageErrors: any[] = [];
  page.on("pageerror", (error?: any) : any => pageErrors.push(error.message));
  await page.goto(serverUrl, { waitUntil: "load" });
  const documentOrigin: any = await page.evaluate(() : any => window.location.origin);
  assert.equal(documentOrigin, new URL(serverUrl).origin, "npm_package_console_cross_origin_asset");
  assert.deepEqual([...origins], [new URL(serverUrl).origin], "npm_package_console_cross_origin_asset");
  assert.deepEqual(pageErrors, [], "npm_package_console_browser_error");
  await page.close();
  return { sameOrigin: true, requestOriginCount: origins.size, pageErrors: 0 };
}

async function runPackagedServerUi({ cwd, rootManifest, onStage = () => {} }: Record<string, any>) : Promise<void> {
  const readyFile: any = path.join(process.env.TMPDIR || "/tmp", `meshrix-ready-${process.pid}.json`);
  const serverData: any = path.join(process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data", "server-ui");
  await fs.mkdir(serverData, { recursive: true });
  const serverEnv: any = npmEnv({ MESHRIX_USER_DATA_DIR: serverData, CODEX_HOME: path.join(serverData, "codex-home") });
  const child: any = spawn(npmCommand(), npmCliArgs(npmInvocation(), ["exec", "--offline", "--", "meshrix-server", "--with-ui", "--port", "0", "--ready-file", readyFile, "--profile", "default", "--data-dir", serverData]), {
    cwd,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();
  let browser: any = null;
  let browserEvidence: any = null;
  try {
    const ready: any = await waitForFile(readyFile, child);
    assert.equal(ready.status, "ready");
    const serverUrl: any = `http://${ready.host}:${ready.port}/`;
    const health: any = await request(serverUrl, "/api/healthz");
    assert.equal(health.response.status, 200, "npm_package_server_health_failed");
    const bootstrap: any = await request(serverUrl, "/api/bootstrap");
    assert.equal(bootstrap.response.status, 200, "npm_package_server_bootstrap_failed");
    const page: any = await request(serverUrl, "/");
    assert.equal(page.response.status, 200, "npm_package_console_html_failed");
    const assets: string[] = [...page.body.matchAll(/(?:src|href)=["']([^"']+)["']/giu)]
      .map((match: RegExpMatchArray) : any => match[1])
      .filter((value?: any) : any => !/^(?:data:|#)/iu.test(value));
    assert.ok(assets.some((asset?: any) : any => /\.js(?:\?|$)/iu.test(asset)), "npm_package_console_js_asset_missing");
    assert.ok(assets.some((asset?: any) : any => /\.css(?:\?|$)/iu.test(asset)), "npm_package_console_css_asset_missing");
    for (const asset of assets) {
      const assetUrl: any = new URL(asset, serverUrl);
      assert.equal(assetUrl.origin, new URL(serverUrl).origin, "npm_package_console_cross_origin_asset");
      const assetResponse: any = await fetch(assetUrl);
      assert.equal(assetResponse.status, 200, "npm_package_console_asset_failed");
      assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, "npm_package_console_asset_empty");
    }
    const installedRoot = path.join(cwd, "node_modules", rootManifest.name);
    const doctorHome = path.join(cwd, ".verification-mcp-doctor-home");
    const discoveryFile = path.join(doctorHome, "mcp", "servers.json");
    await fs.mkdir(path.dirname(discoveryFile), { recursive: true });
    await fs.writeFile(discoveryFile, `${JSON.stringify({
      servers: {
        meshrix: {
          httpUrl: `${serverUrl.replace(/\/+$/u, "")}/mcp`,
          targets: {}
        }
      }
    })}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      onStage("operator_scripts");
      const mcpDoctor = await npm(["run", "--silent", "mcp:doctor", "--", "--url", serverUrl], installedRoot, npmEnv({
        HOME: doctorHome,
        USERPROFILE: doctorHome,
        MESHRIX_MCP_DISCOVERY_FILE: discoveryFile,
        MESHRIX_MCP_BASE_URL: serverUrl
      }));
      const doctorSummary = JSON.parse(mcpDoctor.stdout);
      assert.equal(doctorSummary.ok, true, "npm_package_mcp_doctor_failed");
      assert.equal(doctorSummary.checks?.discovery?.ok, true, "npm_package_mcp_doctor_failed");
      assert.equal(doctorSummary.checks?.discover?.ok, true, "npm_package_mcp_doctor_failed");
      report.cli.mcpDoctor = true;
    } catch {
      throw new Error("npm_package_mcp_doctor_failed");
    }
    onStage("ui_browser");
    browser = await launchBrowser(cwd);
    browserEvidence = await browserForServer(browser, serverUrl);
    report.server = { packagedServerStarted: true, health: true, bootstrap: true, consoleHtml: true, consoleAssets: assets.length, sameOrigin: true, browser: browserEvidence };
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exit: any = await childExit(child);
      assert.equal(exit.signal, null, "npm_package_server_shutdown_failed");
      assert.equal(exit.code, 0, "npm_package_server_shutdown_failed");
    }
    await fs.rm(readyFile, { force: true });
  }
}

function containsCssImportTarget(manifest?: any) : any[] {
  return publicEntries(manifest).filter(({ runtimeTarget }: Record<string, any>) : any => /\.css$/iu.test(runtimeTarget));
}

function cssSpecifierEntries(manifest?: any) : string[] {
  return containsCssImportTarget(manifest).map(({ specifier }: Record<string, any>) : any => specifier);
}

async function runVueBrowserConsumer({ manifest, cwd, toolsDirectory }: Record<string, any>) : Promise<any> {
  const entries: any[] = publicEntries(manifest).filter(({ runtimeTarget }: Record<string, any>) : any => Boolean(runtimeTarget));
  const cssEntries: string[] = cssSpecifierEntries(manifest);
  const moduleEntries: any[] = entries.filter(({ runtimeTarget }: Record<string, any>) : any => !/\.(?:css|d\.ts)$/iu.test(runtimeTarget));
  const component: any = moduleEntries.find(({ subpath, runtimeTarget }: Record<string, any>) : any => /binary-checkbox/iu.test(subpath) || /binarycheckbox\.vue$/iu.test(runtimeTarget));
  assert.ok(component, "npm_package_ui_interactive_export_missing");
  assert.ok(cssEntries.length > 0, "npm_package_ui_styles_export_missing");
  const typedEntries: string[] = packageTypeSpecifiers(manifest);
  const typeImports: any = typedEntries.map((specifier?: any, index?: any) : any => `import type * as PublicEntry${index} from ${JSON.stringify(specifier)};`).join("\n");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "index.html"), "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n", "utf8");
  await fs.writeFile(path.join(cwd, "vite.config.mjs"), `import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\nexport default defineConfig({ plugins: [vue()], build: { outDir: "consumer-dist", emptyOutDir: true } });\n`, "utf8");
  const imports: any = moduleEntries.map(({ specifier }: Record<string, any>) : any => `import * as Export${moduleEntries.findIndex((entry?: any) : any => entry.specifier === specifier)} from ${JSON.stringify(specifier)};`).join("\n");
  const cssImports: any = cssEntries.map((specifier?: any) : any => `import ${JSON.stringify(specifier)};`).join("\n");
  await fs.writeFile(path.join(cwd, "src", "main.ts"), `import { createApp, h, ref } from "vue";\nimport Component from ${JSON.stringify(component.specifier)};\n${imports}\n${cssImports}\ncreateApp({ setup() { const checked = ref(false); return () => h("main", [h(Component, { modelValue: checked.value, label: "Published component", "onUpdate:modelValue": (value: boolean) => { checked.value = value; } }), h("output", { id: "checked-value" }, String(checked.value))]); } }).mount("#app");\n`, "utf8");
  await fs.writeFile(path.join(cwd, "ui-public-entries.ts"), `${typeImports}\nexport type PublicEntries = [${typedEntries.map((_specifier?: any, index?: any) : any => `typeof PublicEntry${index}`).join(", ")}];\n`, "utf8");
  await fs.writeFile(path.join(cwd, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: true }, include: ["ui-public-entries.ts"] }, null, 2)}\n`, "utf8");
  await run(process.execPath, [path.join(toolsDirectory, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.config.mjs"], cwd, npmEnv());
  await run(process.execPath, [path.join(toolsDirectory, "node_modules/vue-tsc/bin/vue-tsc.js"), "--noEmit", "-p", "tsconfig.json"], cwd, npmEnv());
  const html: any = await fs.readFile(path.join(cwd, "consumer-dist", "index.html"), "utf8");
  assert.match(html, /\.js/u, "npm_package_ui_build_javascript_missing");
  assert.match(html, /\.css/u, "npm_package_ui_build_stylesheet_missing");
  const preview: any = spawn(process.execPath, [path.join(toolsDirectory, "node_modules/vite/bin/vite.js"), "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort", "--config", "vite.config.mjs"], { cwd, env: npmEnv(), stdio: ["ignore", "pipe", "pipe"] });
  preview.stderr.resume();
  let browser: any = null;
  try {
    await new Promise((resolve?: any, reject?: any) : any => {
      const outputHandler: any = (chunk?: any) : any => {
        const text: any = Buffer.from(chunk).toString("utf8");
        if (/http:\/\/(?:0\.0\.0\.0|localhost|127\.0\.0\.1):4173/u.test(text)) {
          preview.stdout.off("data", outputHandler);
          resolve(undefined);
        }
      };
      preview.stdout.on("data", outputHandler);
      preview.once("exit", () : any => reject(new Error("npm_package_ui_preview_exited")));
    });
    browser = await launchBrowser(toolsDirectory);
    const page: any = await browser.newPage();
    const origins: any = new Set();
    page.on("request", (requestValue?: any) : any => origins.add(new URL(requestValue.url()).origin));
    const pageErrors: any[] = [];
    page.on("pageerror", (error?: any) : any => pageErrors.push(error.message));
    await page.goto("http://127.0.0.1:4173", { waitUntil: "load" });
    const checkbox: any = page.getByRole("checkbox", { name: "Published component" });
    await checkbox.waitFor({ state: "visible" });
    assert.equal(await checkbox.getAttribute("aria-checked"), "false");
    assert.equal(await page.locator("#checked-value").innerText(), "false");
    await checkbox.click();
    await page.waitForFunction(() => document.querySelector("#checked-value")?.textContent === "true");
    assert.equal(await checkbox.getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("#checked-value").innerText(), "true");
    assert.equal(await checkbox.evaluate((element?: any) : any => getComputedStyle(element).display), "inline-flex");
    assert.deepEqual([...origins], ["http://127.0.0.1:4173"], "npm_package_ui_cross_origin_asset");
    assert.deepEqual(pageErrors, [], "npm_package_ui_browser_error");
    return { runtimeExportCount: moduleEntries.length + cssEntries.length, typeExportCount: typedEntries.length, interaction: true, stylesLoaded: true, sameOrigin: true, browserVersion: browser.version(), requestOriginCount: origins.size, pageErrors: 0 };
  } finally {
    await browser?.close();
    preview.kill("SIGTERM");
    await childExit(preview);
  }
}

async function execute() : Promise<void> {
  assert.equal(platform, runtimePlatform, "npm_package_consumer_platform_mismatch");
  const plan: any = JSON.parse(await fs.readFile(planPath, "utf8"));
  assert.ok(Array.isArray(plan.packages) && plan.packages.length > 0, "npm_package_consumer_plan_empty");
  const home: any = process.env.HOME || "/tmp/home";
  const temporary: any = process.env.TMPDIR || "/tmp";
  const data: any = process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data";
  const cache: any = process.env.npm_config_cache || "/tmp/npm-cache";
  await Promise.all([home, temporary, data, cache].map((directory?: any) : any => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(process.env.npm_config_userconfig || path.join(home, ".npmrc"), "", "utf8");
  const packages: any[] = plan.packages;
  const typeTools: any = { typescript: plan.verifierTools?.typescript, node: plan.verifierTools?.["@types/node"] };
  const vueTools: any = Object.fromEntries(["vite", "@vitejs/plugin-vue", "vue-tsc", "typescript", "@types/node", "@playwright/test"]
    .map((name?: any) : any => {
      const version: any = plan.verifierTools?.[name];
      assert.ok(version, `npm_package_ui_verifier_tool_missing_${safeName(name)}`);
      return [name, version];
    }));
  const base: any = path.join(temporary, "npm-consumers");
  await fs.mkdir(base, { recursive: true });
  report.runtime.npmVersion = (await npm(["--version"], base, npmEnv())).stdout.trim();
  for (let packageIndex = 0; packageIndex < packages.length; packageIndex += 1) {
    const record: any = packages[packageIndex];
    activeFailurePackageIndex = packageIndex;
    activeFailureStage = "npm_install";
    const consumer: any = {
      ...record,
      hasTypes: packageTypeSpecifiers(record.manifest).length > 0
    };
    try {
      const result: any = await installConsumer({
        record: consumer,
        base,
        typeTools,
        vueTools,
        onStage: (stage?: any) : any => {
          if (NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has(stage)) activeFailureStage = stage;
        }
      });
      report.consumers.push(result);
      if (result.browser) report.browser.bundledUi = result.browser;
    } catch (error: unknown) {
      report.failures.push({
        ...consumerFailureSummary(error),
        failureStage: activeFailureStage,
        failurePackageIndex: packageIndex
      });
    }
  }
  report.summary = {
    success: report.failures.length === 0,
    packageCount: report.consumers.length,
    normalInstallLifecycles: report.consumers.every((consumer?: any) : any => consumer.installLifecycleCompleted),
    allConsumersPackageOnly: report.consumers.every((consumer?: any) : any => consumer.directDependencyOnly),
    allRuntimeExports: report.consumers.reduce((count?: any, consumer?: any) : any => count + consumer.runtimeExportCount, 0),
    allTypeExports: report.consumers.reduce((count?: any, consumer?: any) : any => count + consumer.typeExportCount, 0)
  };
  if (report.failures.length > 0) process.exitCode = 1;
  activeFailureStage = "plan_loading";
  activeFailurePackageIndex = -1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await execute();
  } catch (error: any) {
    const platformValue: any = platform === runtimePlatform ? runtimePlatform : "unknown";
    const failure = {
      ...consumerFailureSummary(error),
      failureStage: NPM_PACKAGE_CONSUMER_FAILURE_STAGES.has(activeFailureStage) ? activeFailureStage : "plan_loading",
      failurePackageIndex: Number.isInteger(activeFailurePackageIndex) && activeFailurePackageIndex >= 0
        ? activeFailurePackageIndex
        : null,
      platform: platformValue,
      architecture: runtimeArchitecture
    };
    report.failures.push(failure);
    report.summary = { success: false };
    process.exitCode = 1;
  } finally {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
}
