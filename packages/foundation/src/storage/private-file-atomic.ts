import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isUnsupportedSyncError(error?: any) : any {
  return process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code);
}

async function syncHandleIfSupported(handle?: any) : Promise<any> {
  try {
    await handle?.sync();
  } catch (error: any) {
    if (!isUnsupportedSyncError(error)) {
      throw error;
    }
  }
}

function applyWindowsOwnerOnlyAcl(targetPath?: any) : any {
  if (process.platform !== "win32") return;
  const ace: any = fs.statSync(targetPath).isDirectory()
    ? "*S-1-3-4:(OI)(CI)(F)"
    : "*S-1-3-4:(F)";
  const result: any = spawnSync("icacls", [targetPath, "/inheritance:r", "/grant:r", ace], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0) return;
  const details: any = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
  throw new Error(`Failed to apply Windows owner-only ACL to ${targetPath}: ${details}`);
}

function applyPrivatePermissionsSync(targetPath?: any, mode?: any) : any {
  fs.chmodSync(targetPath, mode);
  applyWindowsOwnerOnlyAcl(targetPath);
}

export function ensurePrivateDir(dir?: any) : any {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  applyPrivatePermissionsSync(dir, 0o700);
}

export async function writePrivateFileAtomic(filePath?: any, content?: any) : Promise<any> {
  const dir: any = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath: any = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let handle: any = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await syncHandleIfSupported(handle);
    await handle.close();
    handle = null;
    await fs.promises.chmod(tempPath, 0o600).catch(() : any => {});
    applyWindowsOwnerOnlyAcl(tempPath);
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.chmod(filePath, 0o600).catch(() : any => {});
    applyWindowsOwnerOnlyAcl(filePath);
    const dirHandle: any = await fs.promises.open(dir, "r").catch(() : any => null);
    try {
      await syncHandleIfSupported(dirHandle);
    } finally {
      await dirHandle?.close();
    }
  } catch (error: any) {
    if (handle) {
      await handle.close().catch(() : any => {});
    }
    await fs.promises.unlink(tempPath).catch(() : any => {});
    throw error;
  }
  return filePath;
}
