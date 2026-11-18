#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT_HYGIENE_REQUIRED_ENTRIES
} from "../tools/registry/architecture-layout-facade.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function exists(relativePath?: any) : Promise<any> {
  try {
    await fs.stat(path.join(repoRoot, relativePath));
    return true;
  } catch (error: any) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

for (const entry of ROOT_HYGIENE_REQUIRED_ENTRIES) {
  assert.equal(await exists(entry), true, `missing required root entry: ${entry}`);
}

console.log("[verify-root-hygiene] ok");
