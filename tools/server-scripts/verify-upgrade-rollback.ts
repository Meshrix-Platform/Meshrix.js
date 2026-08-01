#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const result: any = spawnSync(
  process.execPath,
  [
    "./node_modules/vitest/vitest.ts",
    "run",
    "--config",
    "vitest.config.ts",
    "tests/vitest/server/enterprise-upgrade-rollback.test.ts"
  ],
  { cwd: process.cwd(), stdio: "inherit" }
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
