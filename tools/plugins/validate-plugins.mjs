#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import {
  CATALOG_PLUGIN_SCHEMA,
  CATALOG_PLUGIN_KIND,
  PLUGIN_REGISTRY_SCHEMA,
  RUNTIME_PLUGIN_SCHEMA,
  coreHostContractPath,
  isPlainObject,
  pathExists,
  readJson,
  registryPath,
  repoRoot,
  sanitizeError,
  walkFiles
} from "./lib/repository.mjs";

const ID = /^[a-z][a-z0-9-]*$/u;
const PROVIDER_ID = /^(?:service|coding|document|datastore|agent)-[a-z0-9][a-z0-9-]*$/u;
const PRODUCT_IDS = new Set([
  "external-gateway",
  "model-gateway",
  "shared-space",
  "skill-hub"
]);

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${label} must be a string array`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

async function validateRuntime(entry, manifest, pluginRoot) {
  if (!ID.test(entry.id) || manifest.id !== entry.id || !manifest.label || !manifest.version) throw new Error(`Runtime plugin identity is invalid: ${entry.id}`);
  if (!PRODUCT_IDS.has(entry.id) && !PROVIDER_ID.test(entry.id)) throw new Error(`Runtime plugin id is outside the catalog policy: ${entry.id}`);
  if (manifest.defaultEnabled !== false) throw new Error(`Runtime plugin ${entry.id} must be default-disabled`);
  if (manifest.contributionMode !== undefined && manifest.contributionMode !== "selected") throw new Error(`Runtime plugin ${entry.id} contribution mode is invalid`);
  if (manifest.dependencies === undefined) manifest.dependencies = [];
  for (const field of ["dependencies", "hostCapabilities", "features", "operations", "routes", "mcpTools", "consoleEntries", "stateMachines", "verifierHooks"]) {
    uniqueStrings(field === "routes" ? (manifest.routes || []).map((route) => route?.id) : field === "verifierHooks" ? (manifest.verifierHooks || []).map((hook) => hook?.id) : manifest[field] || [], `${entry.id}.${field}`);
  }
  const runtimePath = String(manifest.runtime?.module || "").replace(/^\.\//u, "");
  if (!runtimePath.endsWith(".mjs") || runtimePath.includes("..") || !(await pathExists(path.join(pluginRoot, runtimePath)))) {
    throw new Error(`Runtime plugin ${entry.id} entrypoint is unavailable`);
  }
  if (!(await pathExists(path.join(pluginRoot, "configuration.schema.json")))) throw new Error(`Runtime plugin ${entry.id} configuration schema is missing`);
  if (!(await pathExists(path.join(pluginRoot, "README.md")))) throw new Error(`Runtime plugin ${entry.id} README is missing`);
  if ((manifest.consoleEntries || []).length > 0 && !(await pathExists(path.join(pluginRoot, "console", "index.mjs")))) {
    throw new Error(`Runtime plugin ${entry.id} precompiled console asset is missing`);
  }
  for (const hook of manifest.verifierHooks || []) {
    if (!hook?.source || String(hook.source).includes("..") || !(await pathExists(path.join(pluginRoot, hook.source)))) {
      throw new Error(`Runtime plugin ${entry.id} verifier source is unavailable`);
    }
  }
}

async function validateCatalog(entry, manifest, pluginRoot) {
  if (manifest.schemaVersion !== CATALOG_PLUGIN_SCHEMA || manifest.kind !== CATALOG_PLUGIN_KIND ||
      manifest.id !== entry.id || !PROVIDER_ID.test(entry.id)) {
    throw new Error(`Catalog plugin identity is invalid: ${entry.id}`);
  }
  for (const field of ["schemaVersion", "name", "status", "types", "summary", "group", "integration", "security", "artifacts"]) {
    if (manifest[field] === undefined) throw new Error(`Catalog plugin ${entry.id} is missing ${field}`);
  }
  if (!Array.isArray(manifest.security?.secrets)) throw new Error(`Catalog plugin ${entry.id} secret declarations are invalid`);
  if (!(await pathExists(path.join(pluginRoot, "README.md")))) throw new Error(`Catalog plugin ${entry.id} README is missing`);
  const adapterPath = String(manifest.artifacts?.clientAdapter || "");
  if (adapterPath) {
    if (adapterPath !== "adapter.json") throw new Error(`Client adapter ${entry.id} descriptor path is invalid`);
    const adapter = await readJson(path.join(pluginRoot, adapterPath));
    const packageJson = await readJson(path.join(pluginRoot, "package.json"));
    if (adapter.schemaVersion !== "v0.0.1:meshrix:client-adapter-descriptor-1" ||
        adapter.protocol !== "v0.0.1:meshrix:client-adapter-json-stdio-1" ||
        adapter.target !== entry.id.replace(/^agent-/u, "") || adapter.packageName !== packageJson.name ||
        adapter.version !== packageJson.version || adapter.entrypoint !== "adapter.mjs" ||
        JSON.stringify(adapter.actions) !== JSON.stringify(["describe", "scan", "install", "verify", "uninstall"]) ||
        JSON.stringify(adapter.locations) !== '["local"]' || !packageJson.bin?.[`meshrix-agent-${adapter.target}-adapter`] ||
        !(await pathExists(path.join(pluginRoot, adapter.entrypoint)))) {
      throw new Error(`Client adapter ${entry.id} contract is invalid`);
    }
    if (entry.release !== true || entry.adapter !== true || entry.runtime !== false || entry.version !== adapter.version ||
        JSON.stringify(entry.adapterContract) !== JSON.stringify({ target: adapter.target, packageName: adapter.packageName, entrypoint: adapter.entrypoint, protocol: adapter.protocol })) {
      throw new Error(`Client adapter ${entry.id} catalog entry is invalid`);
    }
  }
}

async function main() {
  const coreHostContract = await readJson(coreHostContractPath);
  if (coreHostContract.schemaVersion !== "v0.0.1:plugin:host-contract-reference-1" ||
      coreHostContract.bundleManifestSchema !== "meshrix.plugin-bundle.manifest.v1" ||
      coreHostContract.runtimeManifestSchema !== RUNTIME_PLUGIN_SCHEMA ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(coreHostContract.coreContractDigest || ""))) {
    throw new Error("Published Core Host contract reference is invalid");
  }
  const registry = await readJson(registryPath);
  if (registry.schemaVersion !== PLUGIN_REGISTRY_SCHEMA || registry.kind !== "meshrix.plugins.registry" ||
      !Array.isArray(registry.plugins) || registry.plugins.length === 0) {
    throw new Error("Plugin registry is invalid");
  }
  const seen = new Set();
  for (const entry of registry.plugins) {
    if (seen.has(entry.id)) throw new Error(`Duplicate plugin id: ${entry.id}`);
    seen.add(entry.id);
    const pluginRoot = path.join(repoRoot, String(entry.path || ""));
    const manifest = await readJson(path.join(pluginRoot, "plugin.json"));
    if (manifest.schemaVersion === RUNTIME_PLUGIN_SCHEMA) await validateRuntime(entry, manifest, pluginRoot);
    else await validateCatalog(entry, manifest, pluginRoot);
  }
  const releaseRoots = registry.plugins.filter((entry) => entry.runtime === true).map((entry) => path.join(repoRoot, entry.path));
  for (const root of releaseRoots) {
    for (const file of await walkFiles(root)) {
      if (/\.(?:vue|ts|tsx)$/u.test(file.relative)) throw new Error(`Runtime plugin contains uncompiled console source: ${file.relative}`);
      if (file.relative.endsWith(".mjs")) {
        const source = await fs.readFile(file.absolute, "utf8");
        if (/(?:\bfrom\s*|\bimport\s*\()(["'])(?:@lico\/|#lico\/|better-sqlite3)/u.test(source)) {
          throw new Error(`Runtime plugin imports a Core-internal or undeclared package: ${file.relative}`);
        }
      }
    }
  }
  console.log(JSON.stringify({ ok: true, pluginCount: registry.plugins.length, releasePluginCount: releaseRoots.length }));
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
