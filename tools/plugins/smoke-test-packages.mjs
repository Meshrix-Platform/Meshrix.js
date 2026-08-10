#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packPlugins } from "./pack-plugins.mjs";
import { admitPluginPackageArchive } from "../../packages/foundation/src/module-system/plugin-package-validator.ts";
import { packagesRoot, sanitizeError } from "./lib/repository.mjs";

async function smokePackage(record) {
  const bytes = await fs.readFile(path.join(packagesRoot, record.fileName));
  const admission = admitPluginPackageArchive({ bytes, expectedPluginId: record.pluginId });
  const verified = { manifest: admission.verifiedPackage.manifest, files: admission.payloadFiles };
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-smoke-"));
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network access is forbidden during plugin import");
  };
  try {
    for (const [filePath, content] of verified.files) {
      const target = path.join(temporaryRoot, filePath);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, content, { mode: 0o600 });
    }
    const imported = await import(`${pathToFileURL(path.join(temporaryRoot, verified.manifest.entrypoint)).href}?digest=${record.sha256.slice(7, 19)}`);
    if (typeof imported.activatePlugin !== "function") throw new Error(`Plugin ${record.pluginId} does not export activatePlugin`);
    if (fetchCalls !== 0) throw new Error(`Plugin ${record.pluginId} performed network I/O during import`);
    return Object.freeze({ pluginId: record.pluginId, imported: true });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function smokeTestPackages() {
  const packages = await packPlugins();
  const results = [];
  for (const record of packages) results.push(await smokePackage(record));
  return Object.freeze(results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  smokeTestPackages()
    .then((results) => console.log(JSON.stringify({ ok: true, pluginCount: results.length })))
    .catch((error) => {
      console.error(sanitizeError(error));
      process.exitCode = 1;
    });
}
