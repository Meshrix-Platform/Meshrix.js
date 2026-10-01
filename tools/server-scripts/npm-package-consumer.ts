#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync: any = promisify(execFile);
const registry: any = process.env.MESHRIX_NPM_REGISTRY || "";
const reportPath: any = process.env.MESHRIX_NPM_REPORT || "/evidence/consumer-report.json";
const planPath: any = process.env.MESHRIX_NPM_PLAN || "/input/consumer-plan.json";
const platform: any = process.env.MESHRIX_NPM_PLATFORM || `${process.platform}/${process.arch}`;
const runtimeArchitecture: any = process.arch === "x64" ? "amd64" : process.arch;
const report: Record<string, any> = {
  platform,
  runtime: { platform: process.platform, architecture: runtimeArchitecture, processArchitecture: process.arch },
  consumers: [],
  cli: {},
  server: {},
  sqlite: {},
  migrations: {},
  schemaWorker: {},
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
  if (typeof target === "string") return target;
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

function packageTypeSpecifiers(manifest?: any) : string[] {
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
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npmEnv(overrides: Record<string, any> = {}) : any {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME || "/tmp/home",
    TMPDIR: process.env.TMPDIR || "/tmp",
    MESHRIX_USER_DATA_DIR: process.env.MESHRIX_USER_DATA_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    npm_config_userconfig: process.env.npm_config_userconfig,
    npm_config_cache: process.env.npm_config_cache,
    npm_config_registry: registry,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "false",
    npm_config_nodedir: "/usr/local",
    npm_config_jobs: "1",
    MAKEFLAGS: "-j1",
    CFLAGS: "-O1 -g0",
    CXXFLAGS: "-O1 -g0",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    NODE_OPTIONS: "",
    ...overrides
  };
}

async function launchBrowser() : Promise<any> {
  const { chromium } = await import("@playwright/test");
  return chromium.launch({
    executablePath: "/usr/bin/chromium",
    env: { ...process.env, HOME: process.env.HOME || "/tmp/home", XDG_RUNTIME_DIR: process.env.TMPDIR || "/tmp" },
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crashpad", "--disable-crash-reporter"]
  });
}

async function run(command?: any, args?: any[], cwd?: any, environment?: any) : Promise<any> {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: environment || npmEnv()
  });
}

async function npm(args?: any[], cwd?: any, environment?: any) : Promise<any> {
  return run(npmCommand(), args, cwd, environment || npmEnv());
}

async function installConsumer({ record, base, typeTools, vueTools }: Record<string, any>) : Promise<any> {
  const consumerDirectory: any = path.join(base, record.root ? "meshrix-root-consumer" : `leaf-${safeName(record.name)}`);
  const devDependencies: Record<string, any> = record.ui
    ? vueTools
    : typeTools && record.hasTypes
      ? { typescript: typeTools.typescript }
      : {};
  await fs.mkdir(consumerDirectory, { recursive: true });
  await fs.writeFile(path.join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: `meshrix-consumer-${safeName(record.name)}`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [record.name]: record.version },
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
  }, null, 2)}\n`, "utf8");
  await npm(["install", "--no-audit", "--no-fund", "--registry", registry], consumerDirectory);
  const packageManifestPath: any = path.join(consumerDirectory, "node_modules", record.name, "package.json");
  const installedManifest: any = JSON.parse(await fs.readFile(packageManifestPath, "utf8"));
  assert.equal(installedManifest.name, record.name, "npm_package_installed_name_mismatch");
  assert.equal(installedManifest.version, record.version, "npm_package_installed_version_mismatch");
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(consumerDirectory, "package.json"), "utf8")).dependencies), [record.name]);

  const runtimeSpecifiers: string[] = packageRuntimeSpecifiers(installedManifest);
  const runtimeProbePath: any = path.join(consumerDirectory, "meshrix-runtime-exports.mjs");
  await fs.writeFile(runtimeProbePath, `for (const specifier of ${JSON.stringify(runtimeSpecifiers)}) await import(specifier);\n`, "utf8");
  if (runtimeSpecifiers.length > 0) await run(process.execPath, [runtimeProbePath], consumerDirectory, npmEnv());

  const typeSpecifiers: string[] = packageTypeSpecifiers(installedManifest);
  if (typeSpecifiers.length > 0) {
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
    runtimeExportCount: runtimeSpecifiers.length,
    typeExportCount: typeSpecifiers.length,
    installLifecycleCompleted: true,
    ui: record.ui === true
  };
  if (record.ui) result.browser = await runVueBrowserConsumer({ manifest: installedManifest, cwd: consumerDirectory });
  if (record.root) await runRootRuntimeConsumer({ cwd: consumerDirectory, rootManifest: installedManifest });
  if (record.name === "@meshrix/gateway") await runSchemaWorkerProbe({ cwd: consumerDirectory });
  if (record.name === "meshrix-mcp-connector") await runConnectorCli({ cwd: consumerDirectory, version: record.version });
  return result;
}

function safeName(value?: any) : any {
  return String(value || "package").replace(/^@/u, "").replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

async function runConnectorCli({ cwd, version }: Record<string, any>) : Promise<void> {
  const result: any = await npm(["exec", "--offline", "--", "meshrix-mcp", "version", "--json"], cwd);
  const payload: any = JSON.parse(result.stdout);
  assert.equal(payload.packageName, "meshrix-mcp-connector", "npm_package_connector_identity_invalid");
  assert.equal(payload.packageVersion, version, "npm_package_connector_version_invalid");
  report.cli.connectorVersion = true;
}

async function runRootRuntimeConsumer({ cwd, rootManifest }: Record<string, any>) : Promise<void> {
  const runInstalled: any = async (name?: any, args: any[] = []) : Promise<any> => npm(["exec", "--offline", "--", name, ...args], cwd);
  const help: any = await runInstalled("meshrix", ["--help"]);
  assert.match(help.stdout, /Usage:/u, "npm_package_cli_help_failed");
  const interfaces: any = await runInstalled("meshrix", ["interfaces", "--format", "markdown"]);
  assert.match(interfaces.stdout, /jobs\.list/u, "npm_package_cli_offline_interface_failed");
  const serverHelp: any = await runInstalled("meshrix-server", ["--help"]);
  assert.match(serverHelp.stdout, /--with-ui/u, "npm_package_server_cli_help_failed");
  report.cli = { ...report.cli, help: true, offlineInterfaceCatalog: true, serverHelp: true };

  const testData: any = path.join(process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data", "sqlite-consumer");
  await fs.mkdir(testData, { recursive: true });
  const sqliteProbe: any = path.join(cwd, "meshrix-sqlite-probe.mjs");
  await fs.writeFile(sqliteProbe, `import assert from "node:assert/strict";\nimport { createRequire } from "node:module";\nimport { pathToFileURL } from "node:url";\nconst require = createRequire(pathToFileURL(${JSON.stringify(path.join(cwd, "package.json"))}));\nconst Database = require("better-sqlite3");\nconst db = new Database(${JSON.stringify(path.join(testData, "native.sqlite"))});\ndb.exec("CREATE TABLE runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");\ndb.prepare("INSERT INTO runtime_probe (value) VALUES (?)").run("installed-native-sqlite");\nassert.equal(db.prepare("SELECT value FROM runtime_probe WHERE id = 1").get().value, "installed-native-sqlite");\ndb.close();\n`, "utf8");
  await run(process.execPath, [sqliteProbe], cwd, npmEnv());
  report.sqlite = { installedNativeBindingLoaded: true, insertSelectRoundTrip: true };

  const migrationProbe: any = path.join(cwd, "meshrix-migration-probe.mjs");
  await fs.writeFile(migrationProbe, `import assert from "node:assert/strict";\nimport { createRequire } from "node:module";\nimport { pathToFileURL } from "node:url";\nimport { runMigrations } from "@meshrix/foundation/storage/sqlite-migrations";\nconst require = createRequire(pathToFileURL(${JSON.stringify(path.join(cwd, "package.json"))}));\nconst Database = require("better-sqlite3");\nconst db = new Database(${JSON.stringify(path.join(testData, "migration.sqlite"))});\nrunMigrations(db, [{ version: 1, up: (database) => database.exec("CREATE TABLE migration_probe (value TEXT NOT NULL)") }, { version: 2, up: (database) => database.prepare("INSERT INTO migration_probe (value) VALUES (?)").run("packaged-migration") }]);\nassert.equal(db.pragma("user_version", { simple: true }), 2);\nassert.equal(db.prepare("SELECT value FROM migration_probe").get().value, "packaged-migration");\nrunMigrations(db, [{ version: 1, up: () => { throw new Error("applied migration reran"); } }, { version: 2, up: () => { throw new Error("applied migration reran"); } }]);\nassert.equal(db.pragma("user_version", { simple: true }), 2);\ndb.close();\n`, "utf8");
  await run(process.execPath, [migrationProbe], cwd, npmEnv());
  report.migrations = { packagedRunner: true, orderedTransactions: true, schemaVersionPersisted: true, appliedVersionsAreIdempotent: true };

  await runPackagedServerUi({ cwd, rootManifest });
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
    const onExit: any = (code?: any) : any => finish(new Error(`npm_package_server_exited_${code}`));
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

async function browserForServer(browser?: any, serverUrl?: any) : Promise<any> {
  const page: any = await browser.newPage();
  const origins: any = new Set();
  page.on("request", (requestValue?: any) : any => origins.add(new URL(requestValue.url()).origin));
  const pageErrors: any[] = [];
  page.on("pageerror", (error?: any) : any => pageErrors.push(error.message));
  await page.goto(serverUrl, { waitUntil: "load" });
  const documentOrigin: any = await page.evaluate(() : any => window.location.origin);
  assert.deepEqual([...origins], [new URL(serverUrl).origin], "npm_package_console_cross_origin_asset");
  assert.deepEqual(pageErrors, [], "npm_package_console_browser_error");
  await page.close();
  return { documentOrigin, requestOrigins: [...origins], pageErrors: 0 };
}

async function runPackagedServerUi({ cwd }: Record<string, any>) : Promise<void> {
  const readyFile: any = path.join(process.env.TMPDIR || "/tmp", `meshrix-ready-${process.pid}.json`);
  const serverData: any = path.join(process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data", "server-ui");
  await fs.mkdir(serverData, { recursive: true });
  const executable: any = path.join(cwd, "node_modules", ".bin", "meshrix-server");
  await fs.access(executable);
  const serverEnv: any = npmEnv({ MESHRIX_USER_DATA_DIR: serverData, CODEX_HOME: path.join(serverData, "codex-home") });
  const child: any = spawn(executable, ["--with-ui", "--port", "0", "--ready-file", readyFile, "--profile", "default", "--data-dir", serverData], {
    cwd,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output: any[] = [];
  child.stdout.on("data", (chunk?: any) : any => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk?: any) : any => output.push(Buffer.from(chunk)));
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
    browser = await launchBrowser();
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

async function runVueBrowserConsumer({ manifest, cwd }: Record<string, any>) : Promise<any> {
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
  await npm(["exec", "--offline", "--", "vite", "build", "--config", "vite.config.mjs"], cwd);
  await npm(["exec", "--offline", "--", "vue-tsc", "--noEmit", "-p", "tsconfig.json"], cwd);
  const html: any = await fs.readFile(path.join(cwd, "consumer-dist", "index.html"), "utf8");
  assert.match(html, /\.js/u, "npm_package_ui_build_javascript_missing");
  assert.match(html, /\.css/u, "npm_package_ui_build_stylesheet_missing");
  const preview: any = spawn(path.join(cwd, "node_modules", ".bin", "vite"), ["preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort", "--config", "vite.config.mjs"], { cwd, env: npmEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const previewOutput: any[] = [];
  preview.stdout.on("data", (chunk?: any) : any => previewOutput.push(Buffer.from(chunk)));
  preview.stderr.on("data", (chunk?: any) : any => previewOutput.push(Buffer.from(chunk)));
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
      preview.once("exit", (code?: any) : any => reject(new Error(`npm_package_ui_preview_exited_${code}`)));
    });
    browser = await launchBrowser();
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
    return { runtimeExportCount: moduleEntries.length + cssEntries.length, typeExportCount: typedEntries.length, interaction: true, stylesLoaded: true, sameOrigin: true, browserVersion: browser.version(), requestOrigins: [...origins], pageErrors: 0 };
  } finally {
    await browser?.close();
    preview.kill("SIGTERM");
    await childExit(preview);
  }
}

async function execute() : Promise<void> {
  const plan: any = JSON.parse(await fs.readFile(planPath, "utf8"));
  assert.ok(Array.isArray(plan.packages) && plan.packages.length > 0, "npm_package_consumer_plan_empty");
  const home: any = process.env.HOME || "/tmp/home";
  const temporary: any = process.env.TMPDIR || "/tmp";
  const data: any = process.env.MESHRIX_USER_DATA_DIR || "/tmp/meshrix-data";
  const cache: any = process.env.npm_config_cache || "/tmp/npm-cache";
  await Promise.all([home, temporary, data, cache].map((directory?: any) : any => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(process.env.npm_config_userconfig || path.join(home, ".npmrc"), "", "utf8");
  const packages: any[] = plan.packages;
  const typeTools: any = { typescript: plan.verifierTools?.typescript };
  const vueTools: any = Object.fromEntries(["vite", "@vitejs/plugin-vue", "vue-tsc", "typescript", "@playwright/test"]
    .map((name?: any) : any => {
      const version: any = plan.verifierTools?.[name];
      assert.ok(version, `npm_package_ui_verifier_tool_missing_${safeName(name)}`);
      return [name, version];
    }));
  const base: any = path.join(temporary, "npm-consumers");
  await fs.mkdir(base, { recursive: true });
  for (const record of packages) {
    const consumer: any = {
      ...record,
      ui: record.name === "@meshrix/ui-console",
      hasTypes: packageTypeSpecifiers(record.manifest).length > 0
    };
    const result: any = await installConsumer({ record: consumer, base, typeTools, vueTools });
    report.consumers.push(result);
    if (result.browser) report.browser.uiPackage = result.browser;
  }
  report.summary = {
    success: true,
    packageCount: report.consumers.length,
    normalInstallLifecycles: report.consumers.every((consumer?: any) : any => consumer.installLifecycleCompleted),
    allConsumersPackageOnly: report.consumers.every((consumer?: any) : any => consumer.directDependencyOnly),
    allRuntimeExports: report.consumers.reduce((count?: any, consumer?: any) : any => count + consumer.runtimeExportCount, 0),
    allTypeExports: report.consumers.reduce((count?: any, consumer?: any) : any => count + consumer.typeExportCount, 0),
    emulation: process.env.MESHRIX_NPM_EMULATED === "true",
    engineArchitecture: process.env.MESHRIX_NPM_ENGINE_ARCH || "unknown"
  };
}

try {
  await execute();
} catch (error: any) {
  report.summary = { success: false, errorCode: String(error?.message || "npm_package_consumer_failed").match(/npm_package_[a-z0-9_]+/u)?.[0] || "npm_package_consumer_failed" };
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
