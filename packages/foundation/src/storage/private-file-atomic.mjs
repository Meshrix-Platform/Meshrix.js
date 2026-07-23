import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isUnsupportedSyncError(error) {
  return process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

async function syncHandleIfSupported(handle) {
  try {
    await handle?.sync();
  } catch (error) {
    if (!isUnsupportedSyncError(error)) {
      throw error;
    }
  }
}

function applyWindowsOwnerOnlyAcl(targetPath) {
  if (process.platform !== "win32") return;
  const ace = fs.statSync(targetPath).isDirectory()
    ? "*S-1-3-4:(OI)(CI)(F)"
    : "*S-1-3-4:(F)";
  const result = spawnSync("icacls", [targetPath, "/inheritance:r", "/grant:r", ace], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0) return;
  const details = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
  throw new Error(`Failed to apply Windows owner-only ACL to ${targetPath}: ${details}`);
}

function applyPrivatePermissionsSync(targetPath, mode) {
  fs.chmodSync(targetPath, mode);
  applyWindowsOwnerOnlyAcl(targetPath);
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  applyPrivatePermissionsSync(dir, 0o700);
}

export async function writePrivateFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await syncHandleIfSupported(handle);
    await handle.close();
    handle = null;
    await fs.promises.chmod(tempPath, 0o600).catch(() => {});
    applyWindowsOwnerOnlyAcl(tempPath);
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.chmod(filePath, 0o600).catch(() => {});
    applyWindowsOwnerOnlyAcl(filePath);
    const dirHandle = await fs.promises.open(dir, "r").catch(() => null);
    try {
      await syncHandleIfSupported(dirHandle);
    } finally {
      await dirHandle?.close();
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
  return filePath;
}
