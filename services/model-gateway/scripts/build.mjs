#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirs = ["src", "internal", "scripts"];

async function javascriptFiles(directory) {
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(fullPath));
    else if (entry.name.endsWith(".mjs")) files.push(fullPath);
  }
  return files;
}

const files = [];
for (const directory of sourceDirs) files.push(...await javascriptFiles(directory));

for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (check.status !== 0) {
    process.stderr.write(check.stderr || `syntax check failed for ${file}\n`);
    process.exit(check.status ?? 1);
  }
}

await fs.mkdir(path.join(root, "dist"), { recursive: true });
await fs.writeFile(
  path.join(root, "dist", "build.json"),
  `${JSON.stringify({ files: files.length, builtAt: new Date().toISOString() })}\n`,
);
process.stdout.write(`model-gateway build ok (${files.length} source files checked)\n`);
