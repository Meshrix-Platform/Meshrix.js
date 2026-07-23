#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertExistingLocalDirectoryWithinControlledRoots,
  assertExistingLocalFileWithinControlledRoots,
  assertWritablePathWithinRoot,
  controlledLocalSourceRoots,
  pathIsWithinRoot,
} from "../../packages/foundation/src/security/local-path-boundary.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-path-boundary-"));
const allowedRoot = path.join(root, "allowed");
const outsideRoot = path.join(root, "outside");
const nestedDir = path.join(allowedRoot, "nested");
const allowedFile = path.join(nestedDir, "source.txt");
const outsideFile = path.join(outsideRoot, "source.txt");
const linkPath = path.join(allowedRoot, "linked-outside");

await fs.mkdir(nestedDir, { recursive: true });
await fs.mkdir(outsideRoot, { recursive: true });
await fs.writeFile(allowedFile, "inside\n", "utf8");
await fs.writeFile(outsideFile, "outside\n", "utf8");

try {
  await fs.symlink(outsideRoot, linkPath, "dir");
} catch (error) {
  if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
    throw error;
  }
}

assert.equal(pathIsWithinRoot(nestedDir, allowedRoot), true);
assert.equal(pathIsWithinRoot(path.join(allowedRoot, "..", "outside"), allowedRoot), false);

const directoryResult = await assertExistingLocalDirectoryWithinControlledRoots(nestedDir, {
  allowedRoots: [allowedRoot],
});
assert.equal(directoryResult.absolutePath, nestedDir);

const fileResult = await assertExistingLocalFileWithinControlledRoots(allowedFile, {
  allowedRoots: [allowedRoot],
});
assert.equal(fileResult.absolutePath, allowedFile);

await assert.rejects(
  () => assertExistingLocalFileWithinControlledRoots(outsideFile, { allowedRoots: [allowedRoot] }),
  /受控本机来源目录/
);

if (await exists(linkPath)) {
  await assert.rejects(
    () => assertExistingLocalDirectoryWithinControlledRoots(linkPath, { allowedRoots: [allowedRoot] }),
    /符号链接/
  );
}

await assertWritablePathWithinRoot(allowedRoot, path.join(allowedRoot, "new", "file.txt"));
await assert.rejects(
  () => assertWritablePathWithinRoot(allowedRoot, path.join(allowedRoot, "..", "outside", "write.txt")),
  /跳出受控根目录/
);

const roots = controlledLocalSourceRoots({ userDataPath: root });
assert(roots.some((entry) => entry.startsWith(root)));

await fs.rm(root, { recursive: true, force: true });
console.log("local-path-boundary contract passed");

async function exists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}
