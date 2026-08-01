#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

const runnerTemp: any = path.resolve(String(
  process.env.MESHRIX_RUNNER_TEMP || process.env.RUNNER_TEMP || "",
));
const secretRoot: any = path.resolve(String(
  process.env.MESHRIX_REAL_MACHINE_SECRET_ROOT ||
  process.env.SECRET_ROOT ||
  "",
));
if (
  !runnerTemp ||
  !secretRoot ||
  path.basename(secretRoot) !== "meshrix-real-machine-secrets" ||
  path.dirname(secretRoot) !== runnerTemp
) {
  fail("real_machine_secret_cleanup_path_invalid");
}
await fs.rm(secretRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
