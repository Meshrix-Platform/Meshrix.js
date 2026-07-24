import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertPathWithinRootSync } from "@meshrix/foundation/security/local-path-boundary";
import { WORKSPACE_FILE_MAX_BYTES } from "./agent-workspace-core.mjs";

function boundedPath(root, absolutePath, options = {}) {
  return assertPathWithinRootSync(root, absolutePath, {
    allowSpecial: false,
    ...options
  });
}

export function readOrdinaryFileNoFollow(
  root,
  absolutePath,
  { maximumBytes = WORKSPACE_FILE_MAX_BYTES, errorPrefix = "local_directory_file" } = {}
) {
  const bounded = boundedPath(root, absolutePath, {
    label: "本机目录普通文件",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: false,
    allowFile: true
  });
  let descriptor;
  try {
    descriptor = fs.openSync(bounded.absolutePath, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      const error = new Error("本机目录路径不是普通文件。");
      error.code = `${errorPrefix}_not_file`;
      throw error;
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || before.size > maximumBytes) {
      const error = new Error("本机目录文件超过大小限制。");
      error.code = `${errorPrefix}_limit`;
      error.status = 413;
      throw error;
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      const error = new Error("本机目录文件在读取期间发生变化。");
      error.code = `${errorPrefix}_changed`;
      error.status = 409;
      throw error;
    }
    return { content, stat: after };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function ensureDirectorySafely(root, absolutePath, mode = 0o700) {
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
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
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
  root,
  absolutePath,
  content,
  mode = 0o600,
  { preserveExecutable = false } = {}
) {
  ensureDirectorySafely(root, path.dirname(absolutePath), 0o700);
  boundedPath(root, absolutePath, {
    label: "本机目录恢复文件",
    allowMissing: true,
    allowDirectory: false,
    allowFile: true
  });
  const temporaryPath = path.join(path.dirname(absolutePath), `.meshrix-restore-${randomUUID()}.tmp`);
  let descriptor;
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
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(String(error?.code || "")) || !fs.existsSync(absolutePath)) throw error;
      removePathSafely(root, absolutePath, { recursive: true });
      fs.renameSync(temporaryPath, absolutePath);
    }
    fs.chmodSync(absolutePath, Number(mode || 0o600) & (preserveExecutable ? 0o777 : 0o666));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function removePathSafely(root, absolutePath, { recursive = false } = {}) {
  const bounded = boundedPath(root, absolutePath, {
    label: "本机目录 mutation 删除路径",
    allowMissing: false,
    requireExisting: true,
    allowDirectory: true,
    allowFile: true
  });
  if (bounded.stat.isDirectory()) {
    if (recursive) fs.rmSync(bounded.absolutePath, { recursive: true, force: false });
    else fs.rmdirSync(bounded.absolutePath);
  } else {
    fs.unlinkSync(bounded.absolutePath);
  }
  return bounded.stat;
}

export function renamePathSafely(root, sourcePath, targetPath) {
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
    const error = new Error("本机目录 target 在 mutation 前发生变化。");
    error.code = "local_directory_mutation_target_changed";
    error.status = 409;
    throw error;
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
