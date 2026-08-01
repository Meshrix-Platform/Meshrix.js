#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNodeRuntimeCacheDirectory } from "./lib/mcp-release-portable.ts";
import { MCP_RELEASE_TARGETS } from "./lib/mcp-release-platforms.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lockPath: any = path.join(repoRoot, "tools", "release", "node-runtime.lock.json");
const expectedOutputDir: any = path.join(repoRoot, "build", "release", "node-runtime-source");

function argumentValue(name?: any, fallback?: any) : any {
  const index: any = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function sha256(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() : Promise<any> {
  const outputDir: any = path.resolve(argumentValue("--output-dir", expectedOutputDir));
  assert.equal(outputDir, expectedOutputDir, "node_runtime_source_output_out_of_scope");
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const parentStat: any = await fs.lstat(path.dirname(outputDir));
  assert.equal(parentStat.isSymbolicLink(), false, "node_runtime_source_output_parent_symlink");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { mode: 0o755 });
  try {
    const lock: any = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(lock.schemaVersion, "v1:node-runtime-release-lock", "node_runtime_source_lock_invalid");
    const cacheDir: any = resolveNodeRuntimeCacheDirectory();
    const copied: any[] = [];
    for (const target of MCP_RELEASE_TARGETS) {
      const descriptor: any = lock.targets?.[target];
      assert.ok(descriptor, "node_runtime_source_release_target_missing");
      const filename: any = String(descriptor?.filename || "");
      assert.equal(
        /^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(filename) && path.basename(filename) === filename,
        true,
        "node_runtime_source_filename_invalid"
      );
      assert.equal(/^[a-f0-9]{64}$/u.test(String(descriptor.sha256 || "")), true, "node_runtime_source_digest_invalid");
      assert.equal(Number.isSafeInteger(descriptor.sizeBytes) && descriptor.sizeBytes > 0, true, "node_runtime_source_size_invalid");
      const source: any = path.join(cacheDir, filename);
      const stat: any = await fs.lstat(source);
      assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, "node_runtime_source_cache_entry_invalid");
      assert.equal(stat.size, descriptor.sizeBytes, "node_runtime_source_cache_size_mismatch");
      assert.equal(await sha256(source), descriptor.sha256, "node_runtime_source_cache_digest_mismatch");
      const destination: any = path.join(outputDir, filename);
      await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
      assert.equal(await sha256(destination), descriptor.sha256, "node_runtime_source_copy_digest_mismatch");
      copied.push(filename);
    }
    await fs.copyFile(lockPath, path.join(outputDir, "NODE_RUNTIME.lock.json"), fsSync.constants.COPYFILE_EXCL);
    const actual: any = (await fs.readdir(outputDir)).sort();
    const expected: any = ["NODE_RUNTIME.lock.json", ...copied].sort();
    assert.deepEqual(actual, expected, "node_runtime_source_evidence_file_set_mismatch");
    console.log(JSON.stringify({ ok: true, targetCount: copied.length, exactFileSet: true }));
  } catch (error: any) {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() : any => {});
    throw error;
  }
}

main().catch((error?: any) : any => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
