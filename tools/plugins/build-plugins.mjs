#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import {
  loadRuntimePluginEntries,
  pathExists,
  readJson,
  releaseSourceIncluded,
  repoRoot,
  sanitizeError,
  stagedRoot,
  walkFiles
} from "./lib/repository.mjs";

const IMPORT_PATTERNS = Object.freeze([
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*(["'])([^"']+)\1/gmu,
  /^\s*import\s*(["'])([^"']+)\1/gmu,
  /\bimport\s*\(\s*(["'])([^"']+)\1/gu
]);

function assertPortableImports(source, relative) {
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      throw new Error(`Release runtime contains a non-portable import ${specifier} in ${relative}`);
    }
  }
}

async function stagePlugin(entry) {
  const sourceRoot = path.join(repoRoot, entry.path);
  const targetRoot = path.join(stagedRoot, entry.id);
  const manifestPath = path.join(sourceRoot, "plugin.json");
  if (!(await pathExists(manifestPath))) throw new Error(`Runtime plugin manifest is missing: ${entry.path}/plugin.json`);
  const manifest = await readJson(manifestPath);
  if (manifest.id !== entry.id || manifest.version !== entry.version) {
    throw new Error(`Runtime plugin registry identity does not match ${entry.path}/plugin.json`);
  }
  if (manifest.defaultEnabled !== false) throw new Error(`Runtime plugin ${entry.id} must be default-disabled`);
  const runtimePath = String(manifest.runtime?.module || "").replace(/^\.\//u, "");
  if (!runtimePath.endsWith(".mjs") || !(await pathExists(path.join(sourceRoot, runtimePath)))) {
    throw new Error(`Runtime plugin ${entry.id} has no contained .mjs entrypoint`);
  }
  if ((manifest.consoleEntries || []).length > 0 && !(await pathExists(path.join(sourceRoot, "console", "index.mjs")))) {
    throw new Error(`Runtime plugin ${entry.id} has no precompiled console asset`);
  }
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const files = await walkFiles(sourceRoot, { include: releaseSourceIncluded });
  for (const file of files) {
    const bytes = await fs.readFile(file.absolute);
    if (file.relative.endsWith(".mjs")) assertPortableImports(bytes.toString("utf8"), `${entry.path}/${file.relative}`);
    const target = path.join(targetRoot, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { mode: 0o600 });
  }
  return Object.freeze({ id: entry.id, fileCount: files.length, sourceRoot, targetRoot, manifest });
}

export async function buildPlugins() {
  await fs.rm(stagedRoot, { recursive: true, force: true });
  await fs.mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  const entries = await loadRuntimePluginEntries();
  if (entries.length === 0) throw new Error("No release runtime plugins are registered");
  const built = [];
  for (const entry of entries) built.push(await stagePlugin(entry));
  return Object.freeze(built);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  buildPlugins()
    .then((built) => console.log(JSON.stringify({ ok: true, pluginCount: built.length, fileCount: built.reduce((sum, item) => sum + item.fileCount, 0) })))
    .catch((error) => {
      console.error(sanitizeError(error));
      process.exitCode = 1;
    });
}
