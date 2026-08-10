#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import {
  CATALOG_PLUGIN_SCHEMA,
  CATALOG_PLUGIN_KIND,
  PLUGIN_REGISTRY_SCHEMA,
  RUNTIME_PLUGIN_SCHEMA,
  readJson,
  registryPath,
  repoRoot,
  sanitizeError,
  walkFiles
} from "./lib/repository.mjs";

function groupFor(relativePath, manifest) {
  if (manifest.id === "coding-github" || relativePath === "coding/github/plugin.json") return "coding";
  if (manifest.group) return String(manifest.group);
  const parts = relativePath.split("/");
  return parts.length === 2 ? "products" : parts[1] || "products";
}

async function discoverPluginManifests() {
  const pluginsRoot = path.join(repoRoot, "plugins");
  const files = await walkFiles(pluginsRoot, { include: (relative) => relative.endsWith("/plugin.json") || relative === "plugin.json" });
  const entries = [];
  for (const file of files) {
    const manifest = await readJson(file.absolute);
    const pluginPath = `plugins/${path.dirname(file.relative)}`.replace(/\/\.$/u, "");
    const runtime = manifest.schemaVersion === RUNTIME_PLUGIN_SCHEMA;
    const clientAdapterPath = String(manifest.artifacts?.clientAdapter || "");
    const clientAdapter = clientAdapterPath ? await readJson(path.join(path.dirname(file.absolute), clientAdapterPath)) : null;
    if (!runtime && manifest.kind !== CATALOG_PLUGIN_KIND) throw new Error(`Unsupported plugin manifest at ${pluginPath}/plugin.json`);
    entries.push(Object.freeze({
      id: String(manifest.id || ""),
      path: pluginPath,
      status: runtime ? "stable" : String(manifest.status || "draft"),
      version: runtime ? String(manifest.version || "") : clientAdapter ? String(clientAdapter.version || "") : undefined,
      group: groupFor(file.relative, manifest),
      types: runtime ? ["runtime-plugin"] : [...(manifest.types || [])],
      summary: String(manifest.description || manifest.summary || ""),
      runtime,
      adapter: Boolean(clientAdapter),
      release: runtime || Boolean(clientAdapter),
      ...(clientAdapter ? {
        adapterContract: {
          target: clientAdapter.target,
          packageName: clientAdapter.packageName,
          entrypoint: clientAdapter.entrypoint,
          protocol: clientAdapter.protocol
        }
      } : {})
    }));
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function registryFor(plugins) {
  return {
    schemaVersion: PLUGIN_REGISTRY_SCHEMA,
    kind: "meshrix.plugins.registry",
    policy: {
      externalOnly: true,
      namingRule: "Provider plugins use capability-domain prefixes. Migrated product plugins retain stable shared-space and skill-hub identities.",
      uniquenessRule: "One product or upstream concept owns one plugin; sub-capabilities remain inside that plugin.",
      credentialRule: "Credentials use secretRef and are resolved only for an authorized operation.",
      integrationRule: "Runtime plugins use verified one-plugin bundles and public Meshrix Host ports."
    },
    groups: [
      { id: "products", path: "plugins", description: "Detachable Meshrix product plugins." },
      { id: "services", path: "plugins/services", description: "External service wrappers and provider integrations." },
      { id: "coding", path: "plugins/coding", description: "Code hosting, repository, review, CI, and skill-source providers." },
      { id: "documents", path: "plugins/documents", description: "Document and OCR processing plugins." },
      { id: "datastores", path: "plugins/datastores", description: "Datastore and backend mounts." },
      { id: "agents", path: "plugins/agents", description: "Peer adapter plugins." }
    ],
    plugins
  };
}

async function main() {
  const expected = `${JSON.stringify(registryFor(await discoverPluginManifests()), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const actual = await fs.readFile(registryPath, "utf8").catch(() => "");
    if (actual !== expected) throw new Error("Plugin registry is stale; run npm run rebuild:catalog");
    console.log(JSON.stringify({ ok: true, checked: true, pluginCount: JSON.parse(expected).plugins.length }));
    return;
  }
  await fs.mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(registryPath, expected, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, pluginCount: JSON.parse(expected).plugins.length }));
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
