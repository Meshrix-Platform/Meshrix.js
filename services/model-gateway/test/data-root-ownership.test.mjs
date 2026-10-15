import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDataRootOwnership } from "../internal/data-root-ownership.mjs";

test("one process owns a data root until close or process crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-gateway-owner-"));
  let owner;
  let child;
  try {
    owner = await acquireDataRootOwnership(root);
    await assert.rejects(acquireDataRootOwnership(root), /model_gateway_data_root_in_use/u);
    owner.close();
    owner = null;

    const moduleUrl = new URL("../internal/data-root-ownership.mjs", import.meta.url).href;
    const source = `import { acquireDataRootOwnership } from ${JSON.stringify(moduleUrl)}; await acquireDataRootOwnership(process.argv.at(-1)); process.stdout.write("locked\\n"); process.stdin.resume();`;
    child = spawn(process.execPath, ["--input-type=module", "-e", source, root], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        output += chunk;
        if (output.includes("locked\n")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`owner child exited before lock readiness (${code}): ${stderr}`)));
    });
    await assert.rejects(acquireDataRootOwnership(root), /model_gateway_data_root_in_use/u);
    const exit = new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await exit;
    child = null;

    owner = await acquireDataRootOwnership(root);
    owner.close();
    owner = null;
  } finally {
    if (child && child.exitCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exit;
    }
    owner?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("owner sidecar rejects symlinks and restricts an existing file to its owner", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink and mode semantics are not available");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "model-gateway-owner-file-"));
  const target = path.join(root, "state.json");
  const ownerPath = path.join(root, ".model-gateway-owner.sqlite");
  let owner;
  try {
    await writeFile(target, "synthetic-state", { mode: 0o600 });
    await symlink(target, ownerPath);
    await assert.rejects(acquireDataRootOwnership(root), /model_gateway_owner_file_invalid/u);
    assert.equal(await readFile(target, "utf8"), "synthetic-state");
    await rm(ownerPath);

    await writeFile(ownerPath, "", { mode: 0o644 });
    await chmod(ownerPath, 0o644);
    owner = await acquireDataRootOwnership(root);
    assert.equal((await lstat(ownerPath)).mode & 0o777, 0o600);
  } finally {
    owner?.close();
    await rm(root, { recursive: true, force: true });
  }
});
