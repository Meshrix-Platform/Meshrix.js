#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { adapterDescriptors } from "./client-adapter-components.mjs";
import { repoRoot, sanitizeError } from "./lib/repository.mjs";

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
  const descriptors = await adapterDescriptors();
  if (descriptors.length !== 7) throw new Error("exactly seven adapter descriptors are required");
  const antigravity = descriptors.find(({ descriptor }) => descriptor.target === "antigravity");
  if (!antigravity || !String(await fs.readFile(path.join(antigravity.root, "adapter.mjs"), "utf8")).includes("configPath")) {
    throw new Error("Antigravity configPath behavior is missing");
  }
  const failures = [];
  for (const args of [
    ["--test", "packages/client-adapter-kit/test/native-registration.test.mjs", "tests/plugins/client-adapter-contract.test.mjs", "tests/plugins/client-adapters.test.mjs"],
    ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", "tests/vitest/server/pi-adapter-installed-component.test.ts", "tests/vitest/server/client-adapter-runner.test.ts", "tests/vitest/server/mcp-installer-api-key-only.test.ts", "tests/vitest/server/mcp-installer-portability.test.ts", "tests/vitest/server/mcp-public-installer-command.test.ts"],
    ["tools/plugins/smoke-test-client-adapters.mjs"]
  ]) {
    try { const result = await run(process.execPath, args); process.stdout.write(result.stdout); }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  process.stdout.write(`${JSON.stringify({ ok: true, adapterCount: descriptors.length, independentRelease: false, protocol: "v0.0.1:meshrix:client-adapter-json-stdio-1", antigravityConfigPath: true })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
