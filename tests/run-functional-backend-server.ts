#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { backendFunctionalScopeEnvironment } from "./lib/backend-functional-test-scope.ts";

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
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(npmCommand, args, {
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
