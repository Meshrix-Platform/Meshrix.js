#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmCliArgs, parseNpmPackJson, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import {
  createLockBackedNpmRegistry,
  packageManifestFromTarball
} from "./lib/lock-backed-npm-registry.ts";
import { assertNoLeak } from "./lib/report-evidence-safety.ts";
import { discoverReleaseSet } from "./publish-release-set.ts";

const execFileAsync: any = promisify(execFile);
const DEFAULT_REPORT_PATH: any = "build/reports/npm-package-installability.json";
const DEPLOYMENT_INDEX_PATH: any = "packages/foundation/config/deployment/index.json";
const OFFICIAL_NPM_REGISTRY: any = "https://registry.npmjs.org/";
const MAX_COMMAND_OUTPUT_BYTES: any = 64 * 1024 * 1024;
const PLATFORM_ARTIFACT_PATTERN: any =
  /(?:^|\/)(?:build\/Release|prebuilds)\/|\.(?:node|dll|dylib|so(?:\.\d+)*)$/iu;
const ISOLATED_CONSUMER_SOURCE: any = "tools/server-scripts/npm-package-consumer.ts";
const ISOLATED_REGISTRY_SOURCE: any = "tools/server-scripts/npm-registry-server.ts";
const argv: any = process.argv.slice(2);
const inContainer: any = argv.includes("--in-container");
const hostPlatformProbe: any = argv.includes("--host-platform-probe");
const requiredHostProbe: any = argv.includes("--required-host-probe");
const npmCli: any = resolveNpmCliInvocation();

function argumentValue(name?: any) : any {
  const index: any = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "";
}

function npmCommand() : any {
  return npmCli.command;
}

function npmArgs(args?: any) : any {
  return npmCliArgs(npmCli, args);
}

export async function packInstallabilityArtifacts({
  packageRecords,
  packDirectory,
  runPack
}: Record<string, any>) : Promise<any[]> {
  const packedArtifacts: any[] = [];
  for (const packageRecord of packageRecords) {
    const packed: any = await runPack(packageRecord, packDirectory);
    const artifacts: any = parseNpmPackJson(packed.stdout);
    assert.equal(artifacts.length, 1, "npm_package_pack_artifact_count_invalid");
    const artifact: any = artifacts[0];
    assert.equal(artifact?.name, packageRecord.name, "npm_package_release_set_artifact_mismatch");
    assert.equal(artifact?.version, packageRecord.version, "npm_package_release_set_version_mismatch");
    const filename: any = String(artifact?.filename || "");
    assert.ok(filename && path.basename(filename) === filename, "npm_package_pack_filename_invalid");
    const tarballPath: any = path.join(packDirectory, filename);
    const tarballStat: any = await fs.lstat(tarballPath);
    assert.ok(tarballStat.isFile() && !tarballStat.isSymbolicLink(), "npm_package_pack_tarball_invalid");
    packedArtifacts.push({ ...artifact, tarballPath });
  }
  return packedArtifacts;
}

export async function prepareInstallabilityConsumer({
  consumerDirectory,
  packageRecord,
  devDependencies = {}
}: Record<string, any>) : Promise<void> {
  const name: any = String(packageRecord?.name || "");
  const version: any = String(packageRecord?.version || "");
  assert.ok(name && version, "npm_package_consumer_selection_invalid");
  await fs.mkdir(consumerDirectory, { recursive: true });
  await fs.writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({
      name: "meshrix-package-verifier",
      private: true,
      version: "0.0.0",
      type: "module",
      dependencies: { [name]: version },
      ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {})
    }, null, 2)}\n`,
    "utf8"
  );
}

function exportedTargets(exportsField?: any) : any[] {
  if (typeof exportsField === "string") return [{ subpath: ".", target: exportsField }];
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  const keys: any[] = Object.keys(exportsField);
  const hasSubpaths: any = keys.some((key?: any) : any => key === "." || key.startsWith("./"));
  const entries: any[] = hasSubpaths
    ? Object.entries(exportsField).map(([subpath, target]: any[]) : any => ({ subpath, target }))
    : [{ subpath: ".", target: exportsField }];
  return entries.filter(({ target }: Record<string, any>) : any => target !== null && target !== false);
}

function selectedExportTarget(target?: any, condition?: any) : any {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const selected: any = selectedExportTarget(entry, condition);
      if (selected) return selected;
    }
    return "";
  }
  if (!target || typeof target !== "object") return "";
  const priority: any[] = condition === "types"
    ? ["types", "default", "import", "node"]
    : ["import", "node", "default"];
  for (const name of priority) {
    if (Object.hasOwn(target, name)) {
      const selected: any = selectedExportTarget(target[name], condition);
      if (selected) return selected;
    }
  }
  return "";
}

function selectedTypesTarget(target?: any) : any {
  if (!target || typeof target !== "object") return "";
  if (Array.isArray(target)) {
    for (const entry of target) {
      const selected: any = selectedTypesTarget(entry);
      if (selected) return selected;
    }
    return "";
  }
  if (Object.hasOwn(target, "types")) return selectedExportTarget(target.types, "types");
  return "";
}

function packageExportEntries(manifest?: any) : any {
  const name: any = String(manifest?.name || "");
  const entries: any[] = exportedTargets(manifest?.exports).map(({ subpath, target }: Record<string, any>) : any => {
    const runtimeTarget: any = selectedExportTarget(target, "runtime");
    const typesTarget: any = selectedTypesTarget(target);
    const suffix: any = String(subpath || ".").slice(2);
    return {
      subpath,
      specifier: subpath === "." ? name : `${name}/${suffix}`,
      runtimeTarget,
      typesTarget
    };
  });
  if (entries.length === 0 && (manifest?.main || manifest?.module || manifest?.types || manifest?.typings)) {
    entries.push({
      subpath: ".",
      specifier: name,
      runtimeTarget: String(manifest.module || manifest.main || ""),
      typesTarget: String(manifest.types || manifest.typings || "")
    });
  }
  if (entries.length > 0 && (manifest?.types || manifest?.typings)) {
    const rootEntry: any = entries.find(({ subpath }: Record<string, any>) : any => subpath === ".");
    if (rootEntry && !rootEntry.typesTarget) {
      rootEntry.typesTarget = String(manifest.types || manifest.typings);
    }
  }
  return entries;
}

function packageImportSpecifiers(manifest?: any) : string[] {
  return packageExportEntries(manifest)
    .filter(({ runtimeTarget }: Record<string, any>) : any => runtimeTarget && !/\.(?:css|vue)$/iu.test(runtimeTarget))
    .map(({ specifier }: Record<string, any>) : any => String(specifier));
}

function packageTypeSpecifiers(manifest?: any) : string[] {
  return packageExportEntries(manifest)
    .filter(({ typesTarget }: Record<string, any>) : any => Boolean(typesTarget))
    .map(({ specifier }: Record<string, any>) : any => String(specifier));
}

function isVueConsumer(manifest?: any) : boolean {
  return packageExportEntries(manifest).some(({ runtimeTarget }: Record<string, any>) : any => /\.(?:vue|css)$/iu.test(String(runtimeTarget || "")))
    || Object.hasOwn(manifest?.peerDependencies || {}, "vue");
}

function consumerDirectoryName(name?: any) : any {
  return String(name || "package")
    .replace(/^@/u, "")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function commandEntries(binField?: any) : any[] {
  if (typeof binField === "string") return [{ name: "meshrix", path: binField }];
  if (!binField || typeof binField !== "object" || Array.isArray(binField)) return [];
  return Object.entries(binField).map(([name, filePath]: any[]) : any => ({ name, path: filePath }));
}

function dependencyFields(manifest?: any) : any {
  return Object.fromEntries([
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "bin",
    "license"
  ].filter((field?: any) : any => manifest?.[field] !== undefined)
    .map((field?: any) : any => [field, manifest[field]]));
}

async function runNodeExportProbe({ manifest, cwd, runProbeStage }: Record<string, any>) : Promise<number> {
  const specifiers: string[] = packageImportSpecifiers(manifest);
  if (specifiers.length === 0) return 0;
  const source: any = `for (const specifier of ${JSON.stringify(specifiers)}) {\n  await import(specifier);\n}\n`;
  await runProbeStage(
    "npm_package_runtime_exports_failed",
    process.execPath,
    ["--input-type=module", "--eval", source],
    { cwd, classifyRuntime: true }
  );
  return specifiers.length;
}

async function runTypeExportProbe({ manifest, cwd, runProbeStage, rootPackage }: Record<string, any>) : Promise<number> {
  const specifiers: string[] = packageTypeSpecifiers(manifest);
  if (specifiers.length === 0) return 0;
  const typescriptVersion: any = rootPackage.devDependencies?.typescript;
  assert.ok(typescriptVersion, "npm_package_typescript_verifier_dependency_missing");
  const sourcePath: any = path.join(cwd, "meshrix-package-types.ts");
  const imports: any = specifiers.map((specifier?: any, index?: any) : any =>
    `import type * as PublicEntry${index} from ${JSON.stringify(specifier)};`
  ).join("\n");
  await fs.writeFile(sourcePath, `${imports}\nexport type PublicEntries = [${specifiers.map((_specifier?: any, index?: any) : any => `typeof PublicEntry${index}`).join(", ")}];\n`, "utf8");
  const consumerTools: any = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  await fs.access(consumerTools);
  await runProbeStage(
    "npm_package_types_exports_failed",
    process.execPath,
    [consumerTools, "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--noEmit", "--skipLibCheck", sourcePath],
    { cwd, classifyRuntime: true }
  );
  return specifiers.length;
}

function vueRuntimeTarget(entry?: any) : any {
  return String(entry?.runtimeTarget || "");
}

async function runVuePackageConsumer({ manifest, cwd, runProbeStage, rootPackage }: Record<string, any>) : Promise<any> {
  const entries: any[] = packageExportEntries(manifest)
    .filter((entry?: any) : any => Boolean(entry.runtimeTarget));
  const imports: any[] = entries
    .filter((entry?: any) : any => !/\.d\.ts$/iu.test(String(entry.runtimeTarget)))
    .map((entry?: any) : any => entry.specifier);
  assert.ok(imports.length > 0, "npm_package_ui_runtime_exports_missing");
  const interactiveEntry: any = entries.find((entry?: any) : any => /binary-checkbox/iu.test(String(entry.subpath)))
    || entries.find((entry?: any) : any => /\.vue$/iu.test(vueRuntimeTarget(entry)));
  assert.ok(interactiveEntry?.specifier, "npm_package_ui_interactive_export_missing");
  const rootDevDependencies: any = rootPackage.devDependencies || {};
  const toolNames: any[] = ["vite", "@vitejs/plugin-vue", "vue-tsc", "typescript", "vitest", "@vue/test-utils", "jsdom"];
  const toolDependencies: any = Object.fromEntries(toolNames.map((name?: any) : any => {
    assert.ok(rootDevDependencies[name], `npm_package_ui_verifier_dependency_missing_${consumerDirectoryName(name)}`);
    return [name, rootDevDependencies[name]];
  }));
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "index.html"), "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n", "utf8");
  await fs.writeFile(
    path.join(cwd, "vite.config.mjs"),
    `import { defineConfig } from "vitest/config";\nimport vue from "@vitejs/plugin-vue";\nexport default defineConfig({ plugins: [vue()], test: { environment: "jsdom", include: ["ui-consumer.test.ts"], server: { deps: { inline: [${JSON.stringify(manifest.name)}] } } } });\n`,
    "utf8"
  );
  const importLines: any = imports.map((specifier?: any) : any => `import ${JSON.stringify(specifier)};`).join("\n");
  await fs.writeFile(
    path.join(cwd, "src", "main.ts"),
    `import { createApp, h } from "vue";\nimport ElementPlus from "element-plus";\nimport Component from ${JSON.stringify(interactiveEntry.specifier)};\n${importLines}\ncreateApp({ render: () => h(Component, { modelValue: false, label: "Meshrix package probe" }) }).use(ElementPlus).mount("#app");\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "ui-consumer.test.ts"),
    `import { expect, it } from "vitest";\nimport { mount } from "@vue/test-utils";\nimport Component from ${JSON.stringify(interactiveEntry.specifier)};\nit("mounts and exercises an exported interactive component", async () => {\n  const wrapper = mount(Component, { props: { modelValue: false, label: "Meshrix package probe" } });\n  const control = wrapper.get('[role="checkbox"]');\n  expect(control.attributes("aria-checked")).toBe("false");\n  await control.trigger("click");\n  expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);\n  wrapper.unmount();\n});\n`,
    "utf8"
  );
  const typeSpecifiers: any[] = packageTypeSpecifiers(manifest);
  const typeImports: any = typeSpecifiers.map((specifier?: any, index?: any) : any =>
    `import type * as PublicEntry${index} from ${JSON.stringify(specifier)};`
  ).join("\n");
  await fs.writeFile(
    path.join(cwd, "ui-types.ts"),
    `${typeImports}\nexport type PublicEntries = [${typeSpecifiers.map((_specifier?: any, index?: any) : any => `typeof PublicEntry${index}`).join(", ")}];\n`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["vitest/globals"]
    },
    include: ["ui-types.ts", "ui-consumer.test.ts"]
  }, null, 2)}\n`, "utf8");
  await runProbeStage(
    "npm_package_ui_vite_build_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "vite", "build", "--config", "vite.config.mjs"]),
    { cwd, classifyNpmInstall: true }
  );
  await runProbeStage(
    "npm_package_ui_types_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "vue-tsc", "--noEmit", "-p", "tsconfig.json"]),
    { cwd, classifyRuntime: true }
  );
  await runProbeStage(
    "npm_package_ui_interaction_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "vitest", "run", "--config", "vite.config.mjs"]),
    { cwd, classifyRuntime: true }
  );
  return { runtimeExportCount: imports.length, typeExportCount: typeSpecifiers.length, interactiveEntry: interactiveEntry.specifier, verifierToolCount: toolNames.length };
}

async function run(command?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  const baseEnv: any = options.baseEnv || process.env;
  return execFileAsync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
    env: {
      ...baseEnv,
      npm_config_registry: options.registry || OFFICIAL_NPM_REGISTRY,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: options.ignoreScripts === true ? "true" : "false"
    }
  });
}

async function runStage(errorCode?: any, command?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  try {
    return await run(command, args, options);
  } catch (error: any) {
    if (options.classifyNpmInstall === true) {
      const output: any = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (inContainer && String(error?.signal || "").toUpperCase() === "SIGKILL") {
        const memoryEvents = fsSync.readFileSync("/sys/fs/cgroup/memory.events", "utf8");
        const oomKills = Number(memoryEvents.match(/^oom_kill\s+(\d+)$/mu)?.[1] || 0);
        if (oomKills > 0) {
          throw new Error("npm_package_install_oom_killed");
        }
      }
      if (/ENOTCACHED|cache mode is ['"]?only-if-cached/iu.test(output)) {
        const registryPath: any = output.match(
          /https:\/\/registry\.npmjs\.org\/([^\s?]+)/iu
        )?.[1];
        const packageCode: any = registryPath
          ? decodeURIComponent(registryPath)
              .replace(/^@/u, "")
              .replace(/[^a-z0-9]+/giu, "_")
              .replace(/^_+|_+$/gu, "")
              .toLowerCase()
              .slice(0, 80)
          : "unknown";
        throw new Error(`npm_package_offline_cache_incomplete_${packageCode}`);
      }
      if (/node-gyp|gyp ERR|Could not locate the bindings file/iu.test(output)) {
        throw new Error("npm_package_native_dependency_build_failed");
      }
      if (/EACCES|permission denied/iu.test(output)) {
        throw new Error("npm_package_install_permission_denied");
      }
      if (/ERESOLVE/iu.test(output)) {
        throw new Error("npm_package_dependency_resolution_failed");
      }
      if (/ETIMEDOUT|ENETUNREACH|EAI_AGAIN/iu.test(output)) {
        throw new Error("npm_package_registry_unreachable");
      }
      if (/\bENOENT\b/iu.test(output)) {
        const missingPath = output.match(/npm (?:error|ERR!) path ([^\r\n]+)/iu)?.[1]?.trim() || "";
        const normalizedPath = missingPath.replaceAll("\\", "/");
        const modulePath = normalizedPath.match(/\/node_modules\/(@?[^/]+(?:\/[^/]+)?)(?:\/(.*))?$/u);
        const safeTarget = modulePath
          ? `${modulePath[1]}_${path.posix.basename(modulePath[2] || "package")}`
          : path.posix.basename(normalizedPath || "unknown");
        const normalizedTarget = safeTarget
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 100);
        throw new Error(`npm_package_install_enoent_${normalizedTarget || "unknown"}`);
      }
      const npmErrorCode = output.match(/npm (?:error|ERR!) code ([A-Z0-9_]+)/iu)?.[1];
      if (npmErrorCode === "E404") {
        const resource = output.match(/requested resource '([^']+)'/iu)?.[1]
          || output.match(/GET https?:\/\/[^/\s]+\/([^\s?]+)/iu)?.[1]
          || "";
        let decoded = resource;
        try {
          decoded = decodeURIComponent(String(resource));
        } catch {
          decoded = String(resource);
        }
        const packageName = decoded
          .replace(/\/-\/.*$/u, "")
          .replace(/\/[0-9][^/]*$/u, "")
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 80);
        throw new Error(`npm_package_install_e404_${packageName || "unknown"}`);
      }
      if (npmErrorCode) {
        const normalizedCode = npmErrorCode.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
        throw new Error(`npm_package_install_${normalizedCode}`);
      }
      const failedPackage = output.match(
        /node_modules\/(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)[/\\\s]/iu
      )?.[1];
      if (/command failed|lifecycle/iu.test(output) && failedPackage) {
        const normalizedPackage = failedPackage
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .toLowerCase();
        throw new Error(`npm_package_install_script_failed_${normalizedPackage}`);
      }
      const fallbackMarkers = [
        output.trim() ? "output" : "empty",
        /npm (?:error|ERR!)/iu.test(output) ? "npm_error" : "no_npm_error",
        /command failed/iu.test(output) ? "command_failed" : "no_command_failure",
        /not found|no such file/iu.test(output) ? "missing_file" : "no_missing_file",
        `exit_${String(error?.code || "unknown").replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`,
        `signal_${String(error?.signal || "none").replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`
      ];
      throw new Error(`npm_package_release_set_install_failed_${fallbackMarkers.join("_")}`);
    }
    if (options.classifyRuntime === true) {
      const output: any = `${String(error?.stdout || "")}\n${String(error?.stderr || "")}`;
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/iu.test(output)) {
        const missingModule = output.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/iu)?.[1] || "unknown";
        const safeModule = path.isAbsolute(missingModule)
          ? path.basename(missingModule)
          : missingModule;
        const normalizedModule = safeModule
          .replace(/^@/u, "")
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase()
          .slice(0, 100);
        throw new Error(`npm_package_runtime_module_resolution_failed_${normalizedModule || "unknown"}`);
      }
      if (/Could not locate the bindings file|better_sqlite3|better-sqlite3/iu.test(output)) {
        throw new Error("npm_package_runtime_native_storage_failed");
      }
      if (/ENOENT/iu.test(output)) {
        throw new Error("npm_package_runtime_file_missing");
      }
      if (/EACCES|permission denied|read-only file system/iu.test(output)) {
        throw new Error("npm_package_runtime_write_boundary_failed");
      }
      const reasonCode = output.match(/reasonCode=([a-z0-9_]+)/iu)?.[1];
      if (reasonCode) {
        throw new Error(`npm_package_runtime_${reasonCode.toLowerCase()}`);
      }
      const knownRuntimeAssertion = [
        "startup status is missing",
        "UI mode is missing",
        "runtime profile is missing",
        "discovery mode is missing",
        "startup output exposed an endpoint URL",
        "startup output exposed a stack frame",
        "shutdown start status is missing",
        "shutdown completion status is missing",
        "server output exposed an endpoint URL",
        "server output exposed a stack frame",
        "runtime log output is missing",
        "sanitized startup failure status is missing",
        "dynamic port did not require private readiness IPC"
      ].find((message) => output.includes(message));
      if (knownRuntimeAssertion) {
        const normalizedAssertion = knownRuntimeAssertion
          .replace(/[^a-z0-9]+/giu, "_")
          .replace(/^_+|_+$/gu, "")
          .toLowerCase();
        throw new Error(`npm_package_runtime_assertion_${normalizedAssertion}`);
      }
    }
    throw new Error(errorCode);
  }
}

function failureCode(error?: any) : any {
  const message: any = String(error?.message || "");
  const match: any = message.match(/npm_package_[a-z0-9_]+/u);
  return match?.[0] || "npm_package_installability_failed";
}

function selectedHostEnvironment() : any {
  const allowedNames: any[] = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "WINDIR",
    "CI",
    "GITHUB_ACTIONS",
    "RUNNER_OS",
    "PROCESSOR_ARCHITECTURE"
  ];
  return Object.fromEntries(
    allowedNames
      .filter((name?: any) : any => typeof process.env[name] === "string" && process.env[name])
      .map((name?: any) : any => [name, process.env[name]])
  );
}

async function runProbe({ reportPath, freshContainer, requiredReleaseProbe = false }: Record<string, any>) : Promise<any> {
const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-npm-package-installability-"));
const isolatedHome: any = path.join(tempRoot, "home");
const isolatedTemp: any = path.join(tempRoot, "tmp");
const isolatedCache: any = path.join(tempRoot, "npm-cache");
const isolatedData: any = path.join(tempRoot, "meshrix-data");
const isolatedCodexHome: any = path.join(tempRoot, "codex-home");
const isolatedNpmrc: any = path.join(tempRoot, "npmrc");
await Promise.all([
  isolatedHome,
  isolatedTemp,
  isolatedCache,
  isolatedData,
  isolatedCodexHome
].map((directory?: any) : any => fs.mkdir(directory, { recursive: true })));
if (freshContainer === true) {
  await fs.access("/opt/meshrix-npm-cache/_cacache");
}
await fs.writeFile(isolatedNpmrc, "", "utf8");
const probeEnvironment: Record<string, any> = {
  ...selectedHostEnvironment(),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  TMPDIR: isolatedTemp,
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
  XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
  CODEX_HOME: isolatedCodexHome,
  MESHRIX_USER_DATA_DIR: isolatedData,
  NODE_OPTIONS: "--max-old-space-size=384",
  npm_config_userconfig: isolatedNpmrc,
  npm_config_cache: isolatedCache,
  npm_config_jobs: "1",
  MAKEFLAGS: "-j1",
  CFLAGS: "-O1 -g0",
  CXXFLAGS: "-O1 -g0",
  ...(freshContainer === true
    ? {
        npm_config_build_from_source: "true",
        npm_config_nodedir: "/usr/local"
      }
    : {})
};
const runProbeStage: any = (errorCode?: any, command?: any, args?: any, options: Record<string, any> = {}) : any => runStage(
  errorCode,
  command,
  args,
  { ...options, baseEnv: probeEnvironment }
);
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
  verifier: "tools/server-scripts/verify-npm-package-installability.ts",
  generatedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};
function record(name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  report.tests.push({ name, status, evidence });
}

try {
  const rootPackage: any = JSON.parse(await fs.readFile("package.json", "utf8"));
  const releaseSet: any = await discoverReleaseSet({ rootDir: process.cwd() });
  assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
  const expectedBin: any = "dist/apps/server/bin/meshrix.js";
  const expectedServerBin: any = "dist/tools/server-scripts/start-server.js";
  assert.equal(rootPackage.bin?.meshrix, expectedBin, "npm_package_cli_bin_contract_invalid");
  assert.equal(
    rootPackage.bin?.["meshrix-server"],
    expectedServerBin,
    "npm_package_server_bin_contract_invalid"
  );
  assert.equal(rootPackage.bundleDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
  assert.equal(rootPackage.bundledDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
  for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
    assert.equal(
      rootPackage.scripts?.[lifecycleScript],
      undefined,
      "npm_package_root_install_lifecycle_forbidden"
    );
  }

  const workspacePackages: any[] = releaseSet.packages
    .filter((packageRecord?: any) : any => !packageRecord.root && packageRecord.name.startsWith("@meshrix/"))
    .map((packageRecord?: any) : any => ({
      directory: packageRecord.directory,
      name: packageRecord.name
    }));
  const workspaceNames: any = workspacePackages.map(({ name }: Record<string, any>) : any => name).sort();
  const rootInternalDependencies: any = Object.keys(rootPackage.dependencies || {})
    .filter((name?: any) : any => name.startsWith("@meshrix/"))
    .sort();
  assert.deepEqual(
    rootInternalDependencies,
    workspaceNames,
    "npm_package_workspace_dependency_set_incomplete"
  );
  for (const name of workspaceNames) {
    assert.equal(
      rootPackage.dependencies[name],
      rootPackage.version,
      "npm_package_workspace_dependency_version_mismatch"
    );
  }
  record("root package declares the complete version-locked workspace release set", "passed", {
    workspacePackageCount: workspacePackages.length,
    releasePackageCount: releaseSet.packages.length,
    connectorPackageIncluded: releaseSet.packages.some(({ name }: Record<string, any>) : any => name === "meshrix-mcp-connector"),
    versionLocked: true,
    bundledDependencies: false,
    rootInstallLifecycleHooks: false
  });

  const packDirectory: any = path.join(tempRoot, "pack");
  await fs.mkdir(packDirectory, { recursive: true });
  const packedArtifacts: any[] = await packInstallabilityArtifacts({
    packageRecords: releaseSet.packages,
    packDirectory,
    runPack: (packageRecord?: any, destination?: any) : any => runProbeStage(
      "npm_package_release_set_pack_failed",
      npmCommand(),
      npmArgs(["pack", "--json", "--ignore-scripts", "--pack-destination", destination]),
      { cwd: packageRecord.absoluteDirectory }
    )
  });

  let packedFileCount: any = 0;
  const tarballPaths: any[] = [];
  for (const artifact of packedArtifacts) {
    const files: any = Array.isArray(artifact.files)
      ? artifact.files.map((entry?: any) : any => String(entry.path))
      : [];
    packedFileCount += files.length;
    assert.equal(
      files.some((file?: any) : any => file.startsWith("node_modules/")),
      false,
      "npm_package_bundled_node_modules_forbidden"
    );
    assert.equal(
      files.some((file?: any) : any => PLATFORM_ARTIFACT_PATTERN.test(file)),
      false,
      "npm_package_platform_artifact_forbidden"
    );
    tarballPaths.push(artifact.tarballPath);
  }
  const rootArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === rootPackage.name);
  const connectorArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === "meshrix-mcp-connector");
  assert.ok(rootArtifact, "npm_package_root_artifact_missing");
  assert.ok(connectorArtifact, "npm_package_connector_artifact_missing");
  const rootFiles: any = rootArtifact.files.map((entry?: any) : any => String(entry.path));
  const connectorFiles: any = connectorArtifact.files.map((entry?: any) : any => String(entry.path));
  assert.ok(rootFiles.includes(expectedBin), "npm_package_cli_bin_missing");
  assert.ok(rootFiles.includes(expectedServerBin), "npm_package_server_bin_missing");
  assert.match(
    await fs.readFile(expectedServerBin, "utf8"),
    /^#!\/usr\/bin\/env node\r?\n/u,
    "npm_package_server_bin_shebang_missing"
  );
  assert.ok(
    rootFiles.includes("dist/packages/contracts/src/operations/operation-registry.js"),
    "npm_package_internal_runtime_source_missing"
  );
  assert.ok(
    connectorFiles.includes("dist/lib/mcp-proxy-session.js"),
    "npm_package_connector_runtime_source_missing"
  );
  assert.ok(
    connectorFiles.includes("dist/mcp-identity.js"),
    "npm_package_connector_identity_source_missing"
  );
  record("release-set tarballs are source-portable and exclude host artifacts", "passed", {
    packageCount: packedArtifacts.length,
    fileCount: packedFileCount,
    bundledNodeModules: false,
    platformArtifacts: false,
    connectorRuntimeSource: true,
    repositoryInstructionsExcluded: true
  });

  const consumerDirectory: any = path.join(tempRoot, "consumer");
  await prepareInstallabilityConsumer({ consumerDirectory, packedArtifacts });
  const registryMirror: any = freshContainer === true
    ? await createLockBackedNpmRegistry({
        lockPath: "package-lock.json",
        cacheRoot: "/opt/meshrix-npm-cache",
        extraTarballs: packedArtifacts.map((artifact?: any, index?: any) : any => ({
          name: String(artifact.name),
          version: String(artifact.version),
          tarballPath: tarballPaths[index]
        }))
      })
    : null;
  const installRegistry: any = registryMirror?.registry || OFFICIAL_NPM_REGISTRY;
  try {
    await runProbeStage(
      "npm_package_release_set_install_failed",
      npmCommand(),
      npmArgs([
        "install",
        "--ignore-scripts=true",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--registry",
        installRegistry
      ]),
      {
        cwd: consumerDirectory,
        classifyNpmInstall: true,
        registry: installRegistry
      }
    );
  } finally {
    await registryMirror?.close();
  }
  await runProbeStage(
    "npm_package_native_dependency_build_failed",
    npmCommand(),
    npmArgs(["rebuild", "better-sqlite3", "--build-from-source"]),
    {
      cwd: consumerDirectory,
      classifyNpmInstall: true,
      registry: installRegistry
    }
  );

  const help: any = await runProbeStage(
    "npm_package_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(help.stdout, /Usage:/u, "npm_package_cli_help_failed");
  const interfaces: any = await runProbeStage(
    "npm_package_cli_offline_interface_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix", "interfaces", "--format", "markdown"]),
    { cwd: consumerDirectory }
  );
  assert.match(interfaces.stdout, /jobs\.list/u, "npm_package_cli_offline_interface_failed");
  const serverHelp: any = await runProbeStage(
    "npm_package_server_cli_help_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix-server", "--help"]),
    { cwd: consumerDirectory }
  );
  assert.match(
    serverHelp.stdout,
    /--allow-public-console/u,
    "npm_package_server_cli_help_failed"
  );
  const connectorVersion: any = await runProbeStage(
    "npm_package_connector_cli_failed",
    npmCommand(),
    npmArgs(["exec", "--offline", "--", "meshrix-mcp", "version", "--json"]),
    { cwd: consumerDirectory, classifyRuntime: true }
  );
  const connectorPayload: any = JSON.parse(connectorVersion.stdout);
  assert.equal(connectorPayload.packageName, "meshrix-mcp-connector", "npm_package_connector_identity_invalid");
  assert.equal(connectorPayload.packageVersion, rootPackage.version, "npm_package_connector_version_invalid");
  record("clean consumer install runs the packaged CLI", "passed", {
    cliHelp: true,
    offlineInterfaceCatalog: true,
    publicServerCliHelp: true,
    connectorCli: true,
    registryPinned: true,
    lockBackedRegistryMirror: freshContainer === true,
    mirroredPackageCount: registryMirror?.packageCount || 0,
    mirroredArtifactCount: registryMirror?.artifactCount || 0
  });

  const installedRoot: any = path.join(consumerDirectory, "node_modules", rootPackage.name);
  const installedServerBin: any = path.join(
    consumerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "meshrix-server.cmd" : "meshrix-server"
  );
  await fs.access(installedServerBin, fsSync.constants.X_OK);
  await runProbeStage(
    "npm_package_server_startup_smoke_failed",
    process.execPath,
    [
      path.join(installedRoot, "dist/tools/server-scripts/verify-start-server-defaults.js"),
      "--command",
      installedServerBin
    ],
    { cwd: installedRoot, classifyRuntime: true }
  );
  record("installed framework starts and serves its default health contracts", "passed", {
    serverStarted: true,
    healthEndpoint: true,
    bootstrapEndpoint: true,
    rpcHealth: true,
    nativeStorageRuntime: true,
    publicServerBin: true
  });

  report.summary = {
    testCount: report.tests.length,
    failedCount: 0,
    releaseReady: freshContainer === true || requiredReleaseProbe === true,
    reportLeakScan: true,
    freshContainer: freshContainer === true,
    requiredHostProbe: requiredReleaseProbe === true,
    supplementaryHostProbe: freshContainer !== true && requiredReleaseProbe !== true,
    supplementaryReady: freshContainer !== true && requiredReleaseProbe !== true
  };
} catch (error: any) {
  const errorCode: any = failureCode(error);
  record("npm package installability verifier", "failed", { errorCode });
  report.summary = {
    testCount: report.tests.length,
    failedCount: 1,
    releaseReady: false,
    reportLeakScan: false,
    freshContainer: freshContainer === true,
    requiredHostProbe: requiredReleaseProbe === true,
    supplementaryHostProbe: freshContainer !== true && requiredReleaseProbe !== true
  };
  console.error(`[npm-package-installability] failed code=${errorCode}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    report.summary.reportLeakScan = false;
    assertNoLeak(report, "npm package installability report");
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "npm package installability report");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

if (process.exitCode !== 1) {
  const readinessMessage: any = freshContainer === true
    ? "[npm-package-installability] releaseReady=true"
    : requiredReleaseProbe === true
      ? "[npm-package-installability] requiredHostReady=true"
      : "[npm-package-installability] supplementaryHostReady=true";
  console.log(readinessMessage);
}
}

async function writeDefaultReport(report?: any) : Promise<any> {
  assertNoLeak(report, "npm package installability container report");
  await fs.mkdir(path.dirname(DEFAULT_REPORT_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function resolveRepositoryRoot() : any {
  const acceptanceRoot: any = String(process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT || "").trim();
  if (acceptanceRoot) {
    return path.resolve(acceptanceRoot);
  }
  const gitDir: any = String(process.env.GIT_DIR || "").trim();
  if (gitDir) {
    return path.dirname(gitDir);
  }
  return process.cwd();
}

async function runContainerAuthority() : Promise<any> {
  const repoRoot: any = resolveRepositoryRoot();
  const workRoot: any = await fs.mkdtemp(path.join(repoRoot, "build", ".npm-package-isolation-"));
  const packDirectory: any = path.join(workRoot, "artifacts");
  const inputDirectory: any = path.join(workRoot, "input");
  const evidenceDirectory: any = path.join(workRoot, "evidence");
  const rootReportPath: any = path.join(evidenceDirectory, "npm-package-installability.json");
  const generatedAt: any = new Date().toISOString();
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:release:npm-package-installability-report-1",
    verifier: "tools/server-scripts/verify-npm-package-installability.ts",
    generatedAt,
    startedAt: generatedAt,
    tests: [],
    summary: {}
  };
  const imageTags: any[] = [];
  const networkName: any = `meshrix-npm-${process.pid}-${Date.now()}`;
  const registryContainerName: any = `${networkName}-registry`;
  let networkCreated = false;
  let registryStarted = false;
  const record: any = (name?: any, status?: any, evidence: Record<string, any> = {}) : any => {
    report.tests.push({ name, status, evidence });
  };
  const docker: any = (args?: any[], errorCode?: any) : any => runStage(
    errorCode || "npm_package_docker_operation_failed",
    "docker",
    args
  );
  const names: any[] = [
    "root package declares the complete version-locked workspace release set",
    "release-set tarballs are source-portable and exclude host artifacts",
    "clean consumer install runs the packaged CLI",
    "installed framework starts and serves its default health contracts"
  ];

  try {
    await Promise.all([packDirectory, inputDirectory, evidenceDirectory].map((directory?: any) : any =>
      fs.mkdir(directory, { recursive: true })
    ));
    for (const source of [ISOLATED_CONSUMER_SOURCE, ISOLATED_REGISTRY_SOURCE]) {
      await fs.access(path.join(repoRoot, source));
      await fs.access(path.join(repoRoot, "dist", source.replace(/\.ts$/u, ".js")));
    }
    const rootPackage: any = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const lockfile: any = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
    const releaseSet: any = await discoverReleaseSet({ rootDir: repoRoot });
    assert.equal(releaseSet.version, rootPackage.version, "npm_package_release_set_version_mismatch");
    const expectedBin: any = "dist/apps/server/bin/meshrix.js";
    const expectedServerBin: any = "dist/tools/server-scripts/start-server.js";
    assert.equal(rootPackage.bin?.meshrix, expectedBin, "npm_package_cli_bin_contract_invalid");
    assert.equal(rootPackage.bin?.["meshrix-server"], expectedServerBin, "npm_package_server_bin_contract_invalid");
    assert.equal(rootPackage.bundleDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
    assert.equal(rootPackage.bundledDependencies, undefined, "npm_package_bundled_dependencies_forbidden");
    for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
      assert.equal(rootPackage.scripts?.[lifecycleScript], undefined, "npm_package_root_install_lifecycle_forbidden");
    }

    const workspacePackages: any[] = releaseSet.packages.filter((packageRecord?: any) : any =>
      !packageRecord.root && packageRecord.name.startsWith("@meshrix/")
    );
    const workspaceNames: any = workspacePackages.map(({ name }: Record<string, any>) : any => name).sort();
    const rootInternalDependencies: any = Object.keys(rootPackage.dependencies || {})
      .filter((name?: any) : any => name.startsWith("@meshrix/")).sort();
    assert.deepEqual(rootInternalDependencies, workspaceNames, "npm_package_workspace_dependency_set_incomplete");
    for (const name of workspaceNames) {
      assert.equal(rootPackage.dependencies[name], rootPackage.version, "npm_package_workspace_dependency_version_mismatch");
    }
    record(names[0], "passed", {
      workspacePackageCount: workspacePackages.length,
      releasePackageCount: releaseSet.packages.length,
      connectorPackageIncluded: releaseSet.packages.some(({ name }: Record<string, any>) : any => name === "meshrix-mcp-connector"),
      versionLocked: true,
      bundledDependencies: false,
      rootInstallLifecycleHooks: false
    });

    const packedArtifacts: any[] = await packInstallabilityArtifacts({
      packageRecords: releaseSet.packages,
      packDirectory,
      runPack: (packageRecord?: any, destination?: any) : any => runStage(
        "npm_package_release_set_pack_failed",
        npmCommand(),
        npmArgs(["pack", "--json", "--ignore-scripts", "--pack-destination", destination]),
        { cwd: packageRecord.absoluteDirectory }
      )
    });
    const rootArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === rootPackage.name);
    const connectorArtifact: any = packedArtifacts.find(({ name }: Record<string, any>) : any => name === "meshrix-mcp-connector");
    assert.ok(rootArtifact && connectorArtifact, "npm_package_required_artifact_missing");
    const expectedServerBinText: any = await fs.readFile(path.join(repoRoot, expectedServerBin), "utf8");
    assert.match(expectedServerBinText, /^#!\/usr\/bin\/env node\r?\n/u, "npm_package_server_bin_shebang_missing");
    let packedFileCount: any = 0;
    for (const artifact of packedArtifacts) {
      const files: any[] = Array.isArray(artifact.files) ? artifact.files.map((entry?: any) : any => String(entry.path)) : [];
      packedFileCount += files.length;
      assert.equal(files.some((file?: any) : any => file.startsWith("node_modules/")), false, "npm_package_bundled_node_modules_forbidden");
      assert.equal(files.some((file?: any) : any => PLATFORM_ARTIFACT_PATTERN.test(file)), false, "npm_package_platform_artifact_forbidden");
    }
    const rootFiles: any[] = rootArtifact.files.map((entry?: any) : any => String(entry.path));
    const connectorFiles: any[] = connectorArtifact.files.map((entry?: any) : any => String(entry.path));
    assert.ok(rootFiles.includes(expectedBin), "npm_package_cli_bin_missing");
    assert.ok(rootFiles.includes(expectedServerBin), "npm_package_server_bin_missing");
    assert.ok(rootFiles.includes("dist/packages/contracts/src/operations/operation-registry.js"), "npm_package_internal_runtime_source_missing");
    assert.ok(connectorFiles.includes("dist/lib/mcp-proxy-session.js"), "npm_package_connector_runtime_source_missing");
    assert.ok(connectorFiles.includes("dist/mcp-identity.js"), "npm_package_connector_identity_source_missing");
    assert.ok(rootFiles.includes("build/dist/index.html"), "npm_package_console_build_assets_missing");

    const packagePlan: any[] = [];
    for (const packageRecord of releaseSet.packages) {
      const artifact: any = packedArtifacts.find((candidate?: any) : any => candidate.name === packageRecord.name);
      assert.ok(artifact, "npm_package_release_set_artifact_missing");
      const manifest: any = packageManifestFromTarball(await fs.readFile(artifact.tarballPath));
      assert.equal(manifest.name, packageRecord.name, "npm_package_release_set_artifact_mismatch");
      assert.equal(manifest.version, packageRecord.version, "npm_package_release_set_version_mismatch");
      packagePlan.push({ name: manifest.name, version: manifest.version, root: packageRecord.root === true, manifest });
    }
    const registryArtifacts: any = packedArtifacts.map((artifact?: any) : any => ({
      name: String(artifact.name),
      version: String(artifact.version),
      tarballPath: path.join("/artifacts", path.basename(artifact.tarballPath))
    }));
    const registryPlanPath: any = path.join(packDirectory, "registry-artifacts.json");
    await fs.writeFile(registryPlanPath, `${JSON.stringify({ artifacts: registryArtifacts }, null, 2)}\n`, "utf8");

    const lockedToolVersion: any = (name?: any) : any => {
      const version: any = lockfile.packages?.[`node_modules/${name}`]?.version;
      assert.ok(version, `npm_package_locked_verifier_tool_missing_${consumerDirectoryName(name)}`);
      return version;
    };
    const consumerPlanPath: any = path.join(inputDirectory, "consumer-plan.json");
    const containerPlan: any = {
      packages: packagePlan,
      verifierTools: Object.fromEntries([
        "typescript",
        "vite",
        "@vitejs/plugin-vue",
        "vue-tsc",
        "@playwright/test"
      ].map((name?: any) : any => [name, lockedToolVersion(name)]))
    };
    await fs.writeFile(consumerPlanPath, `${JSON.stringify(containerPlan, null, 2)}\n`, "utf8");
    record(names[1], "passed", {
      packageCount: packedArtifacts.length,
      fileCount: packedFileCount,
      bundledNodeModules: false,
      platformArtifacts: false,
      connectorRuntimeSource: true,
      consoleBuildAssets: true,
      repositoryInstructionsExcluded: true,
      packedOnce: true
    });

    const deploymentIndex: any = JSON.parse(await fs.readFile(path.join(repoRoot, DEPLOYMENT_INDEX_PATH), "utf8"));
    const nodeImage: any = String(deploymentIndex?.dockerPresets?.baseImages?.mainService || "");
    assert.match(nodeImage, /^docker\.io\/library\/node:\d+\.\d+\.\d+-[a-z0-9.-]+@sha256:[a-f0-9]{64}$/u, "npm_package_container_image_not_pinned");
    const engineRawArchitecture: any = String((await docker(["info", "--format", "{{.Architecture}}"], "npm_package_docker_engine_unavailable")).stdout || "").trim().toLowerCase();
    const engineArchitecture: any = ({ x86_64: "amd64", aarch64: "arm64" } as Record<string, string>)[engineRawArchitecture] || engineRawArchitecture;
    assert.ok(["amd64", "arm64"].includes(engineArchitecture), "npm_package_docker_engine_architecture_unknown");
    const suffix: any = `${process.pid}-${Date.now()}`;
    const registryImage: any = `meshrix-npm-registry:${suffix}`;
    imageTags.push(registryImage);
    await docker([
      "buildx", "build", "--load", "--quiet", "--target", "npm-package-registry", "--tag", registryImage,
      "--build-arg", `NODE_BASE_IMAGE=${nodeImage}`, "--build-arg", `NPM_REGISTRY=${OFFICIAL_NPM_REGISTRY}`, repoRoot
    ], "npm_package_registry_image_build_failed");
    const platformImages: any[] = [];
    for (const targetPlatform of ["linux/amd64", "linux/arm64"]) {
      const architecture: any = targetPlatform.slice("linux/".length);
      const tag: any = `meshrix-npm-consumer-${architecture}:${suffix}`;
      imageTags.push(tag);
      await docker([
        "buildx", "build", "--load", "--quiet", "--platform", targetPlatform, "--target", "npm-package-consumer", "--tag", tag,
        "--build-arg", `NODE_BASE_IMAGE=${nodeImage}`, repoRoot
      ], "npm_package_consumer_image_build_failed");
      platformImages.push({ platform: targetPlatform, architecture, tag });
    }
    await docker(["network", "create", "--internal", networkName], "npm_package_consumer_network_create_failed");
    networkCreated = true;
    await docker([
      "run", "--detach", "--rm", "--name", registryContainerName, "--network", networkName, "--network-alias", "meshrix-registry",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,size=64m",
      "--mount", `type=bind,src=${packDirectory},dst=/artifacts,readonly`, registryImage,
      "node", "dist/tools/server-scripts/npm-registry-server.js"
    ], "npm_package_registry_start_failed");
    registryStarted = true;
    for (;;) {
      const state: any = String((await docker(["inspect", "--format", "{{.State.Running}}", registryContainerName], "npm_package_registry_start_failed")).stdout || "").trim();
      assert.equal(state, "true", "npm_package_registry_start_failed");
      const readiness: any = await run("docker", [
        "exec", registryContainerName, "node", "--input-type=module", "--eval",
        `const response = await fetch(${JSON.stringify(`http://127.0.0.1:4873/${encodeURIComponent(rootPackage.name)}/${rootPackage.version}`)}); if (!response.ok) process.exit(1);`
      ]).catch(() : any => null);
      if (readiness) break;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 100));
    }

    const platformReports: any[] = [];
    for (const target of platformImages) {
      const platformReportPath: any = path.join(evidenceDirectory, `${target.architecture}.json`);
      const platform: any = target.platform;
      const emulated: any = target.architecture !== engineArchitecture;
      const args: any[] = [
        "run", "--rm", "--platform", platform, "--network", networkName, "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--shm-size=1g", "--tmpfs", "/tmp:rw,exec,nosuid,size=4096m",
        "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp", "--env", "MESHRIX_USER_DATA_DIR=/tmp/meshrix-data",
        "--env", "CODEX_HOME=/tmp/codex-home", "--env", "npm_config_userconfig=/tmp/home/.npmrc", "--env", "npm_config_cache=/tmp/npm-cache",
        "--env", "MESHRIX_NPM_REGISTRY=http://meshrix-registry:4873/", "--env", "MESHRIX_NPM_PLAN=/input/consumer-plan.json",
        "--env", `MESHRIX_NPM_REPORT=/evidence/${target.architecture}.json`, "--env", `MESHRIX_NPM_PLATFORM=${platform}`,
        "--env", `MESHRIX_NPM_EMULATED=${String(emulated)}`, "--env", `MESHRIX_NPM_ENGINE_ARCH=${engineArchitecture}`,
        "--mount", `type=bind,src=${consumerPlanPath},dst=/input/consumer-plan.json,readonly`,
        "--mount", `type=bind,src=${evidenceDirectory},dst=/evidence`,
        target.tag, "node", "/opt/meshrix/npm-package-consumer.js"
      ];
      await docker(args, "npm_package_consumer_runtime_failed");
      const observed: any = JSON.parse(await fs.readFile(platformReportPath, "utf8"));
      assert.equal(observed.summary?.success, true, "npm_package_consumer_runtime_failed");
      assert.equal(observed.runtime?.platform, "linux", "npm_package_consumer_platform_mismatch");
      assert.equal(observed.runtime?.architecture, target.architecture, "npm_package_consumer_architecture_mismatch");
      assert.equal(observed.summary?.packageCount, releaseSet.packages.length, "npm_package_consumer_package_count_mismatch");
      platformReports.push({
        platform,
        architecture: target.architecture,
        emulated,
        engineArchitecture,
        consumerCount: observed.summary.packageCount,
        runtimeExportCount: observed.summary.allRuntimeExports,
        typeExportCount: observed.summary.allTypeExports,
        normalInstallLifecycles: observed.summary.normalInstallLifecycles,
        consumers: observed.consumers,
        cli: observed.cli,
        server: observed.server,
        sqlite: observed.sqlite,
        migrations: observed.migrations,
        schemaWorker: observed.schemaWorker,
        browser: observed.browser
      });
    }
    assert.equal(platformReports.length, 2, "npm_package_platform_report_incomplete");
    record(names[2], "passed", {
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture })),
      consumerCountPerPlatform: releaseSet.packages.length,
      installedRuntimeAndTypes: true,
      installedCli: platformReports.every(({ cli }: Record<string, any>) : any => cli?.help && cli?.offlineInterfaceCatalog && cli?.serverHelp && cli?.connectorVersion),
      uiBrowserInteraction: platformReports.every(({ browser }: Record<string, any>) : any => browser?.uiPackage?.interaction === true),
      normalInstallLifecycle: platformReports.every(({ consumers }: Record<string, any>) : any => consumers.every((consumer?: any) : any => consumer.installLifecycleCompleted))
    });
    record(names[3], "passed", {
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture })),
      serverStartedAndStopped: platformReports.every(({ server }: Record<string, any>) : any => server?.packagedServerStarted === true),
      defaultHealthAndBootstrap: platformReports.every(({ server }: Record<string, any>) : any => server?.health && server?.bootstrap),
      consoleAssetsSameOrigin: platformReports.every(({ server }: Record<string, any>) : any => server?.sameOrigin === true),
      sqliteRoundTrip: platformReports.every(({ sqlite }: Record<string, any>) : any => sqlite?.insertSelectRoundTrip === true),
      packagedMigrations: platformReports.every(({ migrations }: Record<string, any>) : any => migrations?.appliedVersionsAreIdempotent === true),
      installedSchemaWorker: platformReports.every(({ schemaWorker }: Record<string, any>) : any => schemaWorker?.validAndInvalidPayloadsChecked === true),
      platformResults: platformReports
    });
    report.summary = {
      testCount: report.tests.length,
      failedCount: 0,
      releaseReady: true,
      reportLeakScan: true,
      freshContainer: true,
      platforms: platformReports.map(({ platform, emulated, engineArchitecture }: Record<string, any>) : any => ({ platform, emulated, engineArchitecture }))
    };
  } catch (error: any) {
    const errorCode: any = failureCode(error);
    for (const name of names) {
      if (!report.tests.some((test?: any) : any => test.name === name)) {
        record(name, "failed", { errorCode });
      }
    }
    report.summary = {
      testCount: report.tests.length,
      failedCount: report.tests.filter((test?: any) : any => test.status === "failed").length,
      releaseReady: false,
      reportLeakScan: true,
      freshContainer: true
    };
    process.exitCode = 1;
    console.error(`[npm-package-installability] failed code=${errorCode} authority=isolated-consumers`);
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      if (registryStarted) await docker(["rm", "--force", registryContainerName]).catch(() : any => {});
      if (networkCreated) await docker(["network", "rm", networkName]).catch(() : any => {});
      if (imageTags.length > 0) await docker(["image", "rm", "--force", ...imageTags]).catch(() : any => {});
      report.summary.reportLeakScan = false;
      assertNoLeak(report, "npm package installability report");
      report.summary.reportLeakScan = true;
      assertNoLeak(report, "npm package installability report");
      await writeDefaultReport(report);
    } finally {
      await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }
  if (process.exitCode !== 1) {
    console.log("[npm-package-installability] releaseReady=true authority=isolated-consumers platforms=linux/amd64,linux/arm64 report=build/reports/npm-package-installability.json");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (hostPlatformProbe && requiredHostProbe) {
    throw new Error("npm_package_probe_mode_conflict");
  }
  if (inContainer || hostPlatformProbe || requiredHostProbe) {
    await runProbe({
      reportPath: argumentValue("--report-path") || DEFAULT_REPORT_PATH,
      freshContainer: inContainer,
      requiredReleaseProbe: requiredHostProbe
    });
  } else {
    await runContainerAuthority();
  }
}
