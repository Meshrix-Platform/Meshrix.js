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

export function createAgentWorkspaceLocalDirectorySupport({
  userDataPath,
  localDirectoryMountConfigPath,
  createAccessReceipt
}: Record<string, any> = {}) : any {
  function defaultLocalDirectoryMountConfig() : any {
    return {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: localDirectoryMountConfigPath,
      mounts: []
    };
  }

  function readLocalDirectoryMountConfig() : any {
    if (!fs.existsSync(localDirectoryMountConfigPath)) {
      return defaultLocalDirectoryMountConfig();
    }
    try {
      const parsed: any = JSON.parse(fs.readFileSync(localDirectoryMountConfigPath, "utf8"));
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

  function writeLocalDirectoryMountConfig(config: Record<string, any> = {}) : any {
    const next: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      configPath: localDirectoryMountConfigPath,
      mounts: asArray(config.mounts)
    };
    fs.mkdirSync(path.dirname(localDirectoryMountConfigPath), { recursive: true });
    const tmpPath: any = `${localDirectoryMountConfigPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, localDirectoryMountConfigPath);
    return next;
  }

  function validateLocalDirectoryRoot(sourcePath?: any) : any {
    if (!String(sourcePath || "").trim()) {
      throw new Error("sourcePath 不能为空。");
    }
    try {
      return assertExistingLocalDirectoryWithinControlledRootsSync(sourcePath, {
        userDataPath,
        label: "本机目录"
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error("本机目录不存在。");
      }
      throw error;
    }
  }

  function publicLocalDirectoryMount(mount: Record<string, any> = {}) : any {
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

  function resolveLocalDirectorySource(input: Record<string, any> = {}, workspace?: any, { allowDirectSourcePath = false }: Record<string, any> = {}) : any {
    const mountRef: any = String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim();
    if (mountRef) {
      const config: any = readLocalDirectoryMountConfig();
      const mount: any = asArray(config.mounts).find((item?: any) : any =>
        String(item.mountRef || "") === mountRef &&
        String(item.workspaceId || "") === String(workspace.workspaceId || "")
      );
      if (!mount) {
        throw new Error("本机目录 mount 不存在或不属于当前工作空间。");
      }
      if (String(mount.status || "active") !== "active") {
        throw new Error("本机目录 mount 未启用。");
      }
      const root: any = validateLocalDirectoryRoot(mount.sourcePath);
      return {
        sourcePath: root.realPath,
        mount
      };
    }
    const sourcePath: any = String(input.sourcePath || input.localPath || input.dirPath || "").trim();
    if (!allowDirectSourcePath) {
      throw new Error("本机目录访问需要使用已登记的 mountRef。");
    }
    const root: any = validateLocalDirectoryRoot(sourcePath);
    return {
      sourcePath: root.realPath,
      mount: null
    };
  }

  function hasLocalDirectoryMountRef(input: Record<string, any> = {}) : any {
    return Boolean(String(
      input.mountRef ||
        input.mountId ||
        input.localDirMountRef ||
        input.localDirectoryMountRef ||
        ""
    ).trim());
  }

  function localDirectoryInputPath(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
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

  function resolveLocalDirectoryMountPath(input: Record<string, any> = {}, workspace?: any, options: Record<string, any> = {}) : any {
    const source: any = resolveLocalDirectorySource(input, workspace);
    const relativePath: any = localDirectoryInputPath(input, { allowEmpty: options.allowEmpty === true });
    const root: any = source.sourcePath;
    const target: any = resolveVirtualPathWithinRoot(root, relativePath, {
      label: "本机目录 mount 路径"
    }).absolutePath;
    const bounded: any = assertPathWithinRootSync(root, target, {
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
  }: Record<string, any>) : any {
    const isFile: any = stat.isFile();
    const metadata: Record<string, any> = {
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
      const content: any = Buffer.isBuffer(contentBuffer)
        ? contentBuffer
        : readOrdinaryFileNoFollow(rootPath, absolutePath).content;
      metadata.contentSha256 = sha256Buffer(content);
    }
    return metadata;
  }

  function localDirectoryAccessReceipt({ workspaceId = "", mountRef = "", operationId = "", path: receiptPath = "", action = "read" }: Record<string, any> = {}) : any {
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
