#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, readJson, sanitizeError } from "./lib/repository.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed: ${sanitizeError(stderr || stdout)}`)));
  });
}

async function exists(relative) {
  try { await fs.access(path.join(repoRoot, relative)); return true; } catch { return false; }
}

async function main() {
  const registry = await readJson(path.join(repoRoot, "plugins", "registry", "plugins.json"));
  const runtime = registry.plugins.filter((entry) => entry.runtime === true);
  const adapters = registry.plugins.filter((entry) => entry.adapter === true);
  if (registry.plugins.length !== 10 || runtime.length !== 3 || adapters.length !== 7) throw new Error("implemented catalog closure counts are invalid");
  const required = [
    "services/file-parser/format-convert/go.mod",
    "services/file-parser/format-convert/LICENSE",
    "plugins/LICENSE-APACHE-2.0",
    "plugins/core-host-contract.json",
    "plugins/registry/plugins.json",
    "plugins/schemas/plugin-bundle.schema.json",
    "tests/plugins/client-adapters.test.mjs",
    "tools/plugins/pack-plugins.mjs",
    "THIRD_PARTY_NOTICES.md"
  ];
  for (const file of required) if (!(await exists(file))) throw new Error(`missing packaged extension artifact: ${file}`);
  const packageJson = await readJson(path.join(repoRoot, "package.json"));
  for (const root of ["services/", "plugins/", "tools/plugins/", "tests/plugins/"]) {
    if (!packageJson.files.some((entry) => entry === root || entry.startsWith(root))) throw new Error(`package files do not include ${root}`);
  }
  const architectureRoots = packageJson["//architecture-governance"]?.canonicalSourceRoots || [];
  for (const root of ["services/", "plugins/"]) if (!architectureRoots.includes(root)) throw new Error(`architecture policy omits ${root}`);
  const notice = await fs.readFile(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const marker of ["Apache-2.0", "MIT", "tools/plugins/", "tests/plugins/"]) {
    if (!notice.includes(marker)) throw new Error(`mixed license notice omits ${marker}`);
  }
  const pack = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const report = JSON.parse(pack.stdout.trim())[0];
  const packed = new Set((report.files || []).map((entry) => String(entry.path || "").replace(/^package\//u, "")));
  for (const file of ["services/file-parser/format-convert/go.mod", "services/file-parser/format-convert/LICENSE", "plugins/LICENSE-APACHE-2.0", "plugins/registry/plugins.json", "THIRD_PARTY_NOTICES.md"]) {
    if (![...packed].some((entry) => entry === file || entry.startsWith(`${file}/`))) throw new Error(`npm dry-run omitted ${file}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, serviceCount: 1, runtimePluginCount: runtime.length, adapterCount: adapters.length, nestedLicenses: true, npmPackClosure: true })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
