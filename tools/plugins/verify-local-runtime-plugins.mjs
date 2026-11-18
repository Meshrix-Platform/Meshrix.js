#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, readJson, sanitizeError } from "./lib/repository.mjs";
import { assertMigratedExtensionClosure } from "./lib/migrated-extension-closure.mjs";

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

async function assertCanonicalContract() {
  const registry = await readJson(path.join(repoRoot, "plugins", "registry", "plugins.json"));
  const counts = assertMigratedExtensionClosure(registry);
  return counts;
}

async function main() {
  const counts = await assertCanonicalContract();
  await run(process.execPath, ["tools/plugins/rebuild-plugin-catalog.mjs", "--check"]);
  await run(process.execPath, ["tools/plugins/validate-plugins.mjs"]);
  await run(process.execPath, ["tools/plugins/build-plugins.mjs"]);
  await run(process.execPath, ["tools/plugins/pack-plugins.mjs"]);
  await run(process.execPath, ["tools/plugins/smoke-test-packages.mjs"]);
  await run(process.execPath, ["--test", "tests/plugins/shared-space.test.mjs", "tests/plugins/skill-hub.test.mjs"]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...counts, bundleSchema: "meshrix.plugin-bundle.manifest.v1", entrypointExtension: ".mjs" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
