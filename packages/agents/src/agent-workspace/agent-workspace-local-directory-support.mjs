import fs from "node:fs";
import path from "node:path";
import {
  assertExistingLocalDirectoryWithinControlledRootsSync,
  assertPathWithinRootSync,
  resolveVirtualPathWithinRoot
} from "@lico/foundation/security/local-path-boundary";
import {
  asArray,
  asObject,
  normalizeWorkspaceRelativePath,
  sha256Buffer
} from "./agent-workspace-support.mjs";
import { readOrdinaryFileNoFollow } from "./agent-workspace-local-directory-safe-fs.mjs";

export function createAgentWorkspaceLocalDirectorySupport({
  userDataPath,
  localDirectoryMountConfigPath,
  createAccessReceipt
} = {}) {
  function defaultLocalDirectoryMountConfig() {
    return {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: localDirectoryMountConfigPath,
      mounts: []
    };
  }

  function readLocalDirectoryMountConfig() {
    if (!fs.existsSync(localDirectoryMountConfigPath)) {
      return defaultLocalDirectoryMountConfig();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(localDirectoryMountConfigPath, "utf8"));
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        configPath: localDirectoryMountConfigPath,
        ...asObject(parsed),
        mounts: asArray(parsed.mounts)
      };
    } catch {
      return defaultLocalDirectoryMountConfig();
    }
  }

  function writeLocalDirectoryMountConfig(config = {}) {
    const next = {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: localDirectoryMountConfigPath,
      mounts: asArray(config.mounts)
    };
    fs.mkdirSync(path.dirname(localDirectoryMountConfigPath), { recursive: true });
    const tmpPath = `${localDirectoryMountConfigPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, localDirectoryMountConfigPath);
    return next;
  }

  function validateLocalDirectoryRoot(sourcePath) {
    if (!String(sourcePath || "").trim()) {
      throw new Error("sourcePath 不能为空。");
    }
    try {
      return assertExistingLocalDirectoryWithinControlledRootsSync(sourcePath, {
        userDataPath,
        label: "本机目录"
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("本机目录不存在。");
      }
      throw error;
    }
  }

  function publicLocalDirectoryMount(mount = {}) {
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

  function resolveLocalDirectorySource(input = {}, workspace, { allowDirectSourcePath = false } = {}) {
    const mountRef = String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim();
    if (mountRef) {
      const config = readLocalDirectoryMountConfig();
      const mount = asArray(config.mounts).find((item) =>
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

  function hasLocalDirectoryMountRef(input = {}) {
    return Boolean(String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim());
  }

  function localDirectoryInputPath(input = {}, options = {}) {
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

  function resolveLocalDirectoryMountPath(input = {}, workspace, options = {}) {
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

  function localDirectoryAccessReceipt({ workspaceId = "", mountRef = "", operationId = "", path: receiptPath = "", action = "read" } = {}) {
    return {
      ...createAccessReceipt({
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
