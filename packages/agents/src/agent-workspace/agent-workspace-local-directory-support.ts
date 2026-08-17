import fs from "node:fs";
import path from "node:path";
import {
  assertExistingLocalDirectoryWithinControlledRootsSync,
  assertPathWithinRootSync,
  resolveVirtualPathWithinRoot
} from "@meshrix/foundation/security/local-path-boundary";
import {
  asArray,
  asObject,
  normalizeWorkspaceRelativePath,
  sha256Buffer
} from "./agent-workspace-support.ts";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.ts";

interface LocalDirectoryMount {
  mountRef: string;
  workspaceId: string;
  sourcePath: string;
  targetPath?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}
interface ValidatedLocalDirectoryRoot {
  absolutePath: string;
  realPath: string;
  stat: fs.Stats;
  allowedRoots: string[];
}

interface LocalDirectoryMountConfig {
  schemaVersion: string;
  configPath: string;
  mounts: LocalDirectoryMount[];
}

interface LocalDirectoryInput extends Record<string, unknown> {
  mountRef?: unknown;
  mountId?: unknown;
  localDirMountRef?: unknown;
  localDirectoryMountRef?: unknown;
  sourcePath?: unknown;
  localPath?: unknown;
  dirPath?: unknown;
}

interface LocalDirectorySupportOptions {
  userDataPath?: string;
  localDirectoryMountConfigPath?: string;
  createAccessReceipt?: (input: {
    workspaceId: string;
    operationId: string;
    path: string;
    action: string;
  }) => Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMount(value: unknown): LocalDirectoryMount | null {
  if (!isRecord(value)) return null;
  return {
    mountRef: String(value.mountRef || ""),
    workspaceId: String(value.workspaceId || ""),
    sourcePath: String(value.sourcePath || ""),
    targetPath: String(value.targetPath || ""),
    status: String(value.status || "active"),
    createdAt: String(value.createdAt || ""),
    updatedAt: String(value.updatedAt || "")
  };
}

function normalizeMounts(value: unknown): LocalDirectoryMount[] {
  const values: unknown[] = asArray(value);
  return values.map(normalizeMount).filter((mount): mount is LocalDirectoryMount => mount !== null);
}

export function createAgentWorkspaceLocalDirectorySupport({
  userDataPath,
  localDirectoryMountConfigPath,
  createAccessReceipt
}: LocalDirectorySupportOptions = {}) {
  if (!localDirectoryMountConfigPath) {
    throw new TypeError("本机目录 mount 配置路径不可用。");
  }
  if (!createAccessReceipt) {
    throw new TypeError("本机目录访问回执工厂不可用。");
  }
  const mountConfigPath = localDirectoryMountConfigPath;
  const accessReceiptFactory = createAccessReceipt;

  function defaultLocalDirectoryMountConfig(): LocalDirectoryMountConfig {
    return {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: mountConfigPath,
      mounts: []
    };
  }

  function readLocalDirectoryMountConfig(): LocalDirectoryMountConfig {
    if (!fs.existsSync(mountConfigPath)) {
      return defaultLocalDirectoryMountConfig();
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(mountConfigPath, "utf8"));
      const record = isRecord(parsed) ? parsed : {};
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        configPath: mountConfigPath,
        ...asObject(record),
        mounts: normalizeMounts(record.mounts)
      };
    } catch {
      return defaultLocalDirectoryMountConfig();
    }
  }

  function writeLocalDirectoryMountConfig(config: Partial<LocalDirectoryMountConfig> = {}): LocalDirectoryMountConfig {
    const next: LocalDirectoryMountConfig = {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: mountConfigPath,
      mounts: normalizeMounts(config.mounts)
    };
    fs.mkdirSync(path.dirname(mountConfigPath), { recursive: true });
    const tmpPath = `${mountConfigPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, mountConfigPath);
    return next;
  }

  function validateLocalDirectoryRoot(sourcePath?: unknown): ValidatedLocalDirectoryRoot {
    if (!String(sourcePath || "").trim()) {
      throw new Error("sourcePath 不能为空。");
    }
    try {
      const validated = assertExistingLocalDirectoryWithinControlledRootsSync(sourcePath, {
        userDataPath,
        label: "本机目录"
      });
      return {
        absolutePath: validated.absolutePath,
        realPath: validated.realPath,
        stat: validated.stat,
        allowedRoots: [...validated.allowedRoots]
      };
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") {
        throw new Error("本机目录不存在。");
      }
      throw error;
    }
  }

  function publicLocalDirectoryMount(mount: Partial<LocalDirectoryMount> = {}) {
    return {
      mountRef: String(mount.mountRef || ""),
      workspaceId: String(mount.workspaceId || ""),
      targetPath: String(mount.targetPath || ""),
      status: String(mount.status || "active"),
      symlinkPolicy: "reject",
      stateSemantics: {
        source: "localDir",
        sourceState: "staged",
        canonicalState: "archived_after_cas_state_commit"
      },
      createdAt: String(mount.createdAt || ""),
      updatedAt: String(mount.updatedAt || "")
    };
  }

  function resolveLocalDirectorySource(
    input: LocalDirectoryInput = {},
    workspace: { workspaceId?: unknown } = {},
    { allowDirectSourcePath = false }: { allowDirectSourcePath?: boolean } = {}
  ) {
    const mountRef = String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim();
    if (mountRef) {
      const config = readLocalDirectoryMountConfig();
      const mount = config.mounts.find((item) =>
        String(item.mountRef || "") === mountRef &&
        String(item.workspaceId || "") === String(workspace.workspaceId || "")
      );
      if (!mount) {
        throw new Error("本机目录 mount 不存在或不属于当前工作空间。");
      }
      if (String(mount.status || "active") !== "active") {
        throw new Error("本机目录 mount 未启用。");
      }
      const root = validateLocalDirectoryRoot(mount.sourcePath);
      return {
        sourcePath: root.realPath,
        mount
      };
    }
    const sourcePath = String(input.sourcePath || input.localPath || input.dirPath || "").trim();
    if (!allowDirectSourcePath) {
      throw new Error("本机目录访问需要使用已登记的 mountRef。");
    }
    const root = validateLocalDirectoryRoot(sourcePath);
    return {
      sourcePath: root.realPath,
      mount: null
    };
  }

  function hasLocalDirectoryMountRef(input: LocalDirectoryInput = {}): boolean {
    return Boolean(String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim());
  }

  function localDirectoryInputPath(input: Record<string, unknown> = {}, options: { allowEmpty?: boolean } = {}): string {
    return normalizeWorkspaceRelativePath(
      input.path ||
        input.relativePath ||
        input.filePath ||
        input["file-path"] ||
        input.itemPath ||
        input.folderPath ||
        input.directory ||
        "",
      { allowEmpty: options.allowEmpty === true }
    );
  }

  function resolveLocalDirectoryMountPath(
    input: LocalDirectoryInput = {},
    workspace: { workspaceId?: unknown } = {},
    options: { allowEmpty?: boolean; allowMissing?: boolean; requireExisting?: boolean; allowDirectory?: boolean; allowFile?: boolean } = {}
  ) {
    const source = resolveLocalDirectorySource(input, workspace);
    const relativePath = localDirectoryInputPath(input, { allowEmpty: options.allowEmpty === true });
    const root = source.sourcePath;
    const target = resolveVirtualPathWithinRoot(root, relativePath, {
      label: "本机目录 mount 路径"
    }).absolutePath;
    const bounded = assertPathWithinRootSync(root, target, {
      label: "本机目录 mount 路径",
      allowMissing: options.allowMissing !== false,
      requireExisting: options.requireExisting === true,
      allowDirectory: options.allowDirectory !== false,
      allowFile: options.allowFile !== false,
      allowSpecial: false
    });
    return {
      root,
      mount: source.mount,
      relativePath,
      absolutePath: bounded.absolutePath,
      exists: bounded.exists,
      stat: bounded.stat
    };
  }

  function localDirectoryFileMetadataFromStat({
    workspaceId,
    mount,
    relativePath,
    absolutePath,
    stat,
    includeHash = false,
    rootPath = "",
    contentBuffer = null
  }: {
    workspaceId: string;
    mount?: Partial<LocalDirectoryMount> | null;
    relativePath: string;
    absolutePath: string;
    stat: fs.Stats;
    includeHash?: boolean;
    rootPath?: string;
    contentBuffer?: Buffer | null;
  }) {
    const isFile = stat.isFile();
    const metadata = {
      workspaceId,
      mountRef: String(mount?.mountRef || ""),
      relativePath,
      name: path.posix.basename(relativePath) || "",
      type: stat.isDirectory() ? "directory" : isFile ? "file" : "other",
      sizeBytes: stat.isDirectory() ? 0 : Number(stat.size || 0),
      createdAt: stat.birthtime?.toISOString?.() || "",
      updatedAt: stat.mtime?.toISOString?.() || "",
      contentSha256: ""
    };
    if (includeHash && isFile) {
      const content = Buffer.isBuffer(contentBuffer)
        ? contentBuffer
        : readOrdinaryFileNoFollow(rootPath, absolutePath).content;
      metadata.contentSha256 = sha256Buffer(content);
    }
    return metadata;
  }

  function localDirectoryAccessReceipt({ workspaceId = "", mountRef = "", operationId = "", path: receiptPath = "", action = "read" }: {
    workspaceId?: string;
    mountRef?: string;
    operationId?: string;
    path?: string;
    action?: string;
  } = {}) {
    return {
      ...accessReceiptFactory({
        workspaceId,
        operationId,
        path: receiptPath || "/",
        action
      }),
      mountRef
    };
  }


  return {
    readLocalDirectoryMountConfig,
    writeLocalDirectoryMountConfig,
    validateLocalDirectoryRoot,
    publicLocalDirectoryMount,
    resolveLocalDirectorySource,
    hasLocalDirectoryMountRef,
    resolveLocalDirectoryMountPath,
    localDirectoryFileMetadataFromStat,
    localDirectoryAccessReceipt
  };
}
