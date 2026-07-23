#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT_HYGIENE_REQUIRED_ENTRIES
} from "../tools/registry/architecture-layout-facade.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function exists(relativePath) {
  try {
    await fs.stat(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
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
