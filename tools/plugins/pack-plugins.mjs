#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { buildPlugins } from "./build-plugins.mjs";
import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  PLUGIN_BUNDLE_MANIFEST_SCHEMA
} from "../../packages/contracts/src/plugins/plugin-bundle-manifest.ts";
import {
  computePluginPackagePayloadDigest,
  admitPluginPackageArchive
} from "../../packages/foundation/src/module-system/plugin-package-validator.ts";
import { createPluginPackageTarGz } from "../../packages/foundation/src/module-system/plugin-package-tar.ts";
import {
  coreHostContractPath,
  packagesRoot,
  readJson,
  sanitizeError,
  sha256,
  walkFiles
} from "./lib/repository.mjs";

async function packagePlugin(built, coreContractDigest) {
  const fileRecords = [];
  const payload = new Map();
  for (const file of await walkFiles(built.targetRoot)) {
    const content = await fs.readFile(file.absolute);
    payload.set(file.relative, content);
    fileRecords.push(Object.freeze({ path: file.relative, sha256: sha256(content), size: content.length }));
  }
  const configurationSchema = payload.has("configuration.schema.json")
    ? JSON.parse(payload.get("configuration.schema.json").toString("utf8"))
    : {};
  const entrypoint = String(built.manifest.runtime.module).replace(/^\.\//u, "");
  const manifest = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId: built.id,
    version: built.manifest.version,
    label: built.manifest.label,
    entrypoint,
    files: fileRecords,
    coreCompatibility: { contractDigest: coreContractDigest },
    dependencies: [...(built.manifest.dependencies || [])],
    configurationSchema,
    permissions: [...(built.manifest.operations || [])],
    lifecycleHooks: [
      "activate",
      "close",
      ...(payload.get(entrypoint)?.toString("utf8").includes("recoverPluginLifecycle") ? ["recover"] : [])
    ],
    payloadDigest: computePluginPackagePayloadDigest(payload),
    trust: { algorithm: "configured-digest" }
  };
  const archive = createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    ...[...payload].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, content]) => ({ path: filePath, content }))
  ]);
  const verified = admitPluginPackageArchive({ bytes: archive, expectedPluginId: built.id });
  const fileName = `meshrix-plugin-${built.id}-${built.manifest.version}.tar.gz`;
  await fs.writeFile(path.join(packagesRoot, fileName), archive, { mode: 0o600 });
  return Object.freeze({
    pluginId: built.id,
    version: built.manifest.version,
    fileName,
    byteSize: archive.length,
    sha256: verified.verifiedPackage.archiveDigest,
    payloadDigest: verified.verifiedPackage.manifest.payloadDigest
  });
}

export async function packPlugins() {
  const built = await buildPlugins();
  const coreHostContract = await readJson(coreHostContractPath);
  const coreContractDigest = String(coreHostContract.coreContractDigest || "");
  if (!/^sha256:[a-f0-9]{64}$/u.test(coreContractDigest)) {
    throw new Error("Published Core Host contract digest is invalid");
  }
  await fs.rm(packagesRoot, { recursive: true, force: true });
  await fs.mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  const packages = [];
  for (const plugin of built) packages.push(await packagePlugin(plugin, coreContractDigest));
  await fs.writeFile(path.join(packagesRoot, "packages.json"), `${JSON.stringify({ packages }, null, 2)}\n`, { mode: 0o600 });
  return Object.freeze(packages);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  packPlugins()
    .then((packages) => console.log(JSON.stringify({ ok: true, pluginCount: packages.length })))
    .catch((error) => {
      console.error(sanitizeError(error));
      process.exitCode = 1;
    });
}
