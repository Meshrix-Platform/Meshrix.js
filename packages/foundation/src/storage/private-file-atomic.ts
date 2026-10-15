import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
}

function isUnsupportedSyncError(error: unknown): boolean {
  return process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(errorCode(error));
}

async function syncHandleIfSupported(handle?: FileHandle | null, directory = false): Promise<void> {
  try {
    await handle?.sync();
  } catch (error: unknown) {
    if (!directory || !isUnsupportedSyncError(error)) {
      throw error;
    }
  }
}

// Node has no DACL API. Keep the unavoidable Windows adapter narrow: replace
// only the directory DACL, including explicit grants, before creating children.
// New files inherit the owner-only ACE; renaming preserves their descriptor.
const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $directory = [System.IO.DirectoryInfo]::new($env:MESHRIX_PRIVATE_DIRECTORY)
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;OW)', [System.Security.AccessControl.AccessControlSections]::Access)
  $directory.SetAccessControl($acl)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function windowsDirectoryAclCommand(targetPath: string): {
  executable: string; args: string[]; env: NodeJS.ProcessEnv;
} {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable");
  return {
    executable: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_DIRECTORY_SCRIPT],
    // Paths are data, never interpolated into the command or evaluated as code.
    env: { ...process.env, MESHRIX_PRIVATE_DIRECTORY: targetPath },
  };
}

function applyWindowsOwnerOnlyAcl(targetPath: string): void {
  if (process.platform !== "win32") return;
  const command = windowsDirectoryAclCommand(targetPath);
  const result = spawnSync(command.executable, command.args, {
    env: command.env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status === 0) return;
  const details = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
  throw new Error(`Failed to apply Windows owner-only ACL to ${targetPath}: ${details}`);
}

function applyWindowsOwnerOnlyAclAsync(targetPath: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const command = windowsDirectoryAclCommand(targetPath);
    const child = spawn(
      command.executable,
      command.args,
      { env: command.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (details: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to apply Windows owner-only ACL to ${targetPath}: ${details}`));
    };

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => fail(error.message));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve();
        return;
      }
      const details = stderr.trim() || stdout.trim() || `exit code ${code ?? signal ?? "unknown"}`;
      fail(details);
    });
  });
}

function applyPrivatePermissionsSync(targetPath: string, mode: number): void {
  fs.chmodSync(targetPath, mode);
  applyWindowsOwnerOnlyAcl(targetPath);
}

// Pending durability obligations, not a cache of trusted paths. Registration is
// synchronous with mkdir so sync and async callers cannot observe a new directory
// before its ancestor entries have been recorded. Successful sync removes them.
const pendingDirectorySync = new Map<string, object>();

function createPrivateDirectory(dir: string): string {
  const directory = path.resolve(dir);
  const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated) {
    const stop = path.dirname(path.resolve(firstCreated));
    for (let current = directory; ; current = path.dirname(current)) {
      // Replacing the token preserves a later creation while an earlier async
      // sync is in flight, even when both creations share the same ancestor.
      pendingDirectorySync.set(current, {});
      if (current === stop) break;
    }
  }
  return directory;
}

function pendingAncestors(directory: string): Array<readonly [string, object]> {
  return Array.from(pendingDirectorySync).filter(([ancestor]) => {
    const relative = path.relative(ancestor, directory);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  });
}

function syncDirectoryIfSupportedSync(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    if (!isUnsupportedSyncError(error)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await syncHandleIfSupported(handle, true);
  } catch (error: unknown) {
    if (!isUnsupportedSyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

export function ensurePrivateDir(dir: string): void {
  const directory = createPrivateDirectory(dir);
  applyPrivatePermissionsSync(directory, 0o700);
  for (const [ancestor, token] of pendingAncestors(directory)) {
    syncDirectoryIfSupportedSync(ancestor);
    if (pendingDirectorySync.get(ancestor) === token) pendingDirectorySync.delete(ancestor);
  }
}

async function ensurePrivateDirAsync(dir: string): Promise<void> {
  const directory = createPrivateDirectory(dir);
  await fs.promises.chmod(directory, 0o700);
  await applyWindowsOwnerOnlyAclAsync(directory);
  for (const [ancestor, token] of pendingAncestors(directory)) {
    await syncDirectoryIfSupported(ancestor);
    if (pendingDirectorySync.get(ancestor) === token) pendingDirectorySync.delete(ancestor);
  }
}

export async function writePrivateFileAtomic(filePath: string, content: string | Uint8Array): Promise<string> {
  const dir = path.dirname(filePath);
  await ensurePrivateDirAsync(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let handle: FileHandle | null = null;
  try {
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await syncHandleIfSupported(handle);
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, filePath);
    await syncDirectoryIfSupported(dir);
  } catch (error: unknown) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
  return filePath;
}
