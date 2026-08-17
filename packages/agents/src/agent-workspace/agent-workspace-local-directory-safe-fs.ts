import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertPathWithinRootSync } from "@meshrix/foundation/security/local-path-boundary";
import { WORKSPACE_FILE_MAX_BYTES } from "./agent-workspace-core.ts";

interface LocalDirectoryFsError extends Error { code?: string; status?: number }
interface BoundedPathOptions {
  label?: string; allowMissing?: boolean; requireExisting?: boolean;
  allowDirectory?: boolean; allowFile?: boolean; allowSpecial?: boolean;
}
interface ReadOrdinaryFileOptions { maximumBytes?: number; errorPrefix?: string }

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code || "") : "";
}

function localDirectoryFsError(message: string, code: string, status?: number): LocalDirectoryFsError {
  const error: LocalDirectoryFsError = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function requiredStat(stat: fs.Stats | null): fs.Stats {
  if (!stat) throw localDirectoryFsError("本机目录路径状态不可用。", "local_directory_path_state_unavailable", 409);
  return stat;
}

function boundedPath(root: string, absolutePath: string, options: BoundedPathOptions = {}) {
  return assertPathWithinRootSync(root, absolutePath, {
    allowSpecial: false,
    ...options
  });
}

export function readOrdinaryFileNoFollow(
  root: string,
  absolutePath: string,
  { maximumBytes = WORKSPACE_FILE_MAX_BYTES, errorPrefix = "local_directory_file" }: ReadOrdinaryFileOptions = {}
): { content: Buffer; stat: fs.Stats } {
  const bounded = boundedPath(root, absolutePath, {
    label: "本机目录普通文件",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: false,
    allowFile: true
  });
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(bounded.absolutePath, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw localDirectoryFsError("本机目录路径不是普通文件。", `${errorPrefix}_not_file`);
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || before.size > maximumBytes) {
      throw localDirectoryFsError("本机目录文件超过大小限制。", `${errorPrefix}_limit`, 413);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw localDirectoryFsError("本机目录文件在读取期间发生变化。", `${errorPrefix}_changed`, 409);
    }
    return { content, stat: after };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function ensureDirectorySafely(root: string, absolutePath: string, mode = 0o700) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(absolutePath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = resolvedRoot;
  let targetCreated = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const before = boundedPath(resolvedRoot, current, {
      label: "本机目录 mutation 目录",
      allowMissing: true,
      allowDirectory: true,
      allowFile: false
    });
    if (!before.exists) {
      boundedPath(resolvedRoot, path.dirname(current), {
        label: "本机目录 mutation 父目录",
        allowMissing: false,
        requireExisting: true,
        allowDirectory: true,
        allowFile: false
      });
      try {
        fs.mkdirSync(current, { recursive: false, mode: index === segments.length - 1 ? Number(mode) & 0o777 : 0o700 });
        if (index === segments.length - 1) targetCreated = true;
      } catch (error: unknown) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    boundedPath(resolvedRoot, current, {
      label: "本机目录 mutation 目录",
      allowMissing: false,
      requireExisting: true,
      allowDirectory: true,
      allowFile: false
    });
  }
  const after = boundedPath(resolvedRoot, resolvedTarget, {
    label: "本机目录 mutation 目录",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: true,
    allowFile: false
  });
  if (targetCreated) fs.chmodSync(after.absolutePath, Number(mode) & 0o777);
  return after;
}

export function writeFileAtomically(
  root: string,
  absolutePath: string,
  content: string | NodeJS.ArrayBufferView,
  mode = 0o600,
  { preserveExecutable = false }: { preserveExecutable?: boolean } = {}
): void {
  ensureDirectorySafely(root, path.dirname(absolutePath), 0o700);
  boundedPath(root, absolutePath, {
    label: "本机目录恢复文件",
    allowMissing: true,
    allowDirectory: false,
    allowFile: true
  });
  const temporaryPath = path.join(path.dirname(absolutePath), `.meshrix-restore-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | Number(fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    boundedPath(root, path.dirname(absolutePath), {
      label: "本机目录恢复文件父路径",
      allowMissing: false,
      requireExisting: true,
      allowDirectory: true,
      allowFile: false
    });
    boundedPath(root, absolutePath, {
      label: "本机目录恢复文件",
      allowMissing: true,
      allowDirectory: false,
      allowFile: true
    });
    try {
      fs.renameSync(temporaryPath, absolutePath);
    } catch (error: unknown) {
      if (!["EEXIST", "EPERM"].includes(errorCode(error)) || !fs.existsSync(absolutePath)) throw error;
      removePathSafely(root, absolutePath, { recursive: true });
      fs.renameSync(temporaryPath, absolutePath);
    }
    fs.chmodSync(absolutePath, Number(mode || 0o600) & (preserveExecutable ? 0o777 : 0o666));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function removePathSafely(root: string, absolutePath: string, { recursive = false }: { recursive?: boolean } = {}): fs.Stats {
  const bounded = boundedPath(root, absolutePath, {
    label: "本机目录 mutation 删除路径",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: true,
    allowFile: true
  });
  const stat = requiredStat(bounded.stat);
  if (stat.isDirectory()) {
    if (recursive) fs.rmSync(bounded.absolutePath, { recursive: true, force: false });
    else fs.rmdirSync(bounded.absolutePath);
  } else {
    fs.unlinkSync(bounded.absolutePath);
  }
  return stat;
}

export function renamePathSafely(root: string, sourcePath: string, targetPath: string) {
  const source = boundedPath(root, sourcePath, {
    label: "本机目录 mutation source",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: true,
    allowFile: true
  });
  ensureDirectorySafely(root, path.dirname(targetPath), 0o700);
  const target = boundedPath(root, targetPath, {
    label: "本机目录 mutation target",
    allowMissing: true,
    allowDirectory: true,
    allowFile: true
  });
  if (target.exists) {
    throw localDirectoryFsError("本机目录 target 在 mutation 前发生变化。", "local_directory_mutation_target_changed", 409);
  }
  fs.renameSync(source.absolutePath, target.absolutePath);
  return boundedPath(root, target.absolutePath, {
    label: "本机目录 mutation target",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: true,
    allowFile: true
  });
}
