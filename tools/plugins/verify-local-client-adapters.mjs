#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { adapterTargets, adapterDescriptors } from "./client-adapter-packages.mjs";
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

async function main() {
  const registry = await readJson(path.join(repoRoot, "plugins", "registry", "plugins.json"));
  const catalogAdapters = registry.plugins.filter((entry) => entry.adapter === true);
  if (catalogAdapters.length !== adapterTargets.length) throw new Error("adapter catalog count mismatch");
  const descriptors = await adapterDescriptors();
  if (descriptors.length !== 7) throw new Error("exactly seven implemented adapters are required");
  const antigravity = descriptors.find(({ descriptor }) => descriptor.target === "antigravity");
  if (!antigravity || !String(await fs.readFile(path.join(antigravity.root, "adapter.mjs"), "utf8")).includes("configPath")) {
    throw new Error("Antigravity configPath behavior is missing");
  }
  await run(process.execPath, ["--test", "tests/plugins/client-adapter-contract.test.mjs", "tests/plugins/client-adapters.test.mjs", "tests/plugins/pi-extension.test.mjs"]);
  await run(process.execPath, ["tools/plugins/pack-client-adapters.mjs"]);
  await run(process.execPath, ["tools/plugins/smoke-test-client-adapters.mjs"]);
  process.stdout.write(`${JSON.stringify({ ok: true, adapterCount: descriptors.length, protocol: "v0.0.1:meshrix:client-adapter-json-stdio-1", antigravityConfigPath: true })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
