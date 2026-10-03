#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { backendFunctionalScopeEnvironment } from "./lib/backend-functional-test-scope.ts";
import { npmCliArgs, resolveNpmCliInvocation } from "../tools/server-scripts/lib/npm-cli-invocation.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const shardById: Readonly<Record<string, string>> = Object.freeze({
  "shard-a": "1/2",
  "shard-b": "2/2"
});

export function backendServerShardVitestArgs(shardId: string): string[] {
  const shard = shardById[shardId];
  if (!shard) {
    throw new Error(`Unknown backend Server shard: ${shardId || "<missing>"}.`);
  }
  return [
    "run",
    "vitest",
    "--",
    "tests/vitest/server",
    "tests/server",
    "--maxWorkers=2",
    `--shard=${shard}`
  ];
}

async function main(): Promise<void> {
  const args = backendServerShardVitestArgs(String(process.argv[2] || ""));
  // Run npm through the Node entrypoint rather than spawning `npm.cmd`:
  // Node refuses to spawn a `.cmd` without a shell, and `shell: true` is not an
  // accepted launcher boundary here.
  const npmInvocation = resolveNpmCliInvocation();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(npmInvocation.command, npmCliArgs(npmInvocation, args), {
      cwd: repoRoot,
      env: backendFunctionalScopeEnvironment(),
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
