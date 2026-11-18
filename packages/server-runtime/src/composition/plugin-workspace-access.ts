import { randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { pathIsWithinRoot } from "#meshrix/foundation/security/local-path-boundary";

export const PLUGIN_WORKSPACE_ACCESS_METHODS: readonly any[] = Object.freeze([
  "readTextFile",
  "writeTextFile"
]);

function normalizePluginWorkspacePath(value?: any) : any {
  const raw: any = String(value || "").trim().replaceAll("\\", "/");
  const normalized: any = path.posix.normalize(raw);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.isAbsolute(raw)
  ) {
    throw new Error("Plugin workspace path is not a bounded relative path.");
  }
  return normalized;
}

function pluginWorkspaceAccessError(code?: any) : any {
  const error: Error & Record<string, any> = new Error("Plugin workspace access was denied.");
  error.code = code;
  return error;
}

async function assertRegularWorkspaceRoot(workspaceRoot?: any, fileSystem?: any) : Promise<any> {
  const rootStat: any = await fileSystem.lstat(workspaceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Plugin workspace boundary is unavailable.");
  }
  return fileSystem.realpath(workspaceRoot);
}

async function resolvePluginWorkspacePath({
  workspaceRoot,
  relativePath,
  fileSystem,
  forWrite = false
}: Record<string, any>) : Promise<any> {
  const normalizedPath: any = normalizePluginWorkspacePath(relativePath);
  const absolutePath: any = path.resolve(workspaceRoot, normalizedPath);
  if (!pathIsWithinRoot(absolutePath, workspaceRoot)) {
    throw new Error("Plugin workspace path is outside its boundary.");
  }
  const realRoot: any = await assertRegularWorkspaceRoot(workspaceRoot, fileSystem);
  const segments: any = normalizedPath.split("/").filter(Boolean);
  let current: any = workspaceRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat: any = await fileSystem.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Plugin workspace parent is outside its boundary.");
      }
      const realPath: any = await fileSystem.realpath(current);
      if (!pathIsWithinRoot(realPath, realRoot)) {
        throw new Error("Plugin workspace parent is outside its boundary.");
      }
    } catch (error: any) {
      if (forWrite && error?.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const stat: any = await fileSystem.lstat(absolutePath);
    if (stat.isSymbolicLink() || (!forWrite && !stat.isFile())) {
      throw new Error("Plugin workspace target is not a regular file.");
    }
    const realPath: any = await fileSystem.realpath(absolutePath);
    if (!pathIsWithinRoot(realPath, realRoot)) {
      throw new Error("Plugin workspace target is outside its boundary.");
    }
  } catch (error: any) {
    if (!forWrite || error?.code !== "ENOENT") throw error;
  }
  return Object.freeze({ normalizedPath, absolutePath });
}

async function ensurePluginWorkspaceParents({ workspaceRoot, normalizedPath, fileSystem }: Record<string, any>) : Promise<any> {
  const rootRealPath: any = await assertRegularWorkspaceRoot(workspaceRoot, fileSystem);
  const parentSegments: any = normalizedPath.split("/").filter(Boolean).slice(0, -1);
  let current: any = workspaceRoot;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    try {
      await fileSystem.mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat: any = await fileSystem.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Plugin workspace parent is outside its boundary.");
    }
    const realPath: any = await fileSystem.realpath(current);
    if (!pathIsWithinRoot(realPath, rootRealPath)) {
      throw new Error("Plugin workspace parent is outside its boundary.");
    }
  }
  return path.dirname(path.resolve(workspaceRoot, normalizedPath));
}

export function createPluginWorkspaceAccess({ workspaceRoot, fileSystem = fs }: Record<string, any> = {}) : any {
  const boundedRoot: any = path.resolve(String(workspaceRoot || ""));
  if (!String(workspaceRoot || "").trim()) {
    throw new Error("Plugin workspace access requires an explicit workspace root.");
  }
  const source: Readonly<Record<string, any>> = Object.freeze({
    lstat: fileSystem.lstat.bind(fileSystem),
    realpath: fileSystem.realpath.bind(fileSystem),
    mkdir: fileSystem.mkdir.bind(fileSystem),
    open: fileSystem.open.bind(fileSystem),
    rename: fileSystem.rename.bind(fileSystem),
    unlink: fileSystem.unlink.bind(fileSystem)
  });
  return Object.freeze({
    async readTextFile({ path: relativePath }: Record<string, any> = {}) : Promise<any> {
      let handle: any;
      try {
        const resolved: any = await resolvePluginWorkspacePath({
          workspaceRoot: boundedRoot,
          relativePath,
          fileSystem: source
        });
        handle = await source.open(
          resolved.absolutePath,
          fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW
        );
        return await handle.readFile("utf8");
      } catch {
        throw pluginWorkspaceAccessError("PLUGIN_WORKSPACE_READ_DENIED");
      } finally {
        await handle?.close().catch(() : any => {});
      }
    },
    async writeTextFile({ path: relativePath, content = "" }: Record<string, any> = {}) : Promise<any> {
      let temporaryPath: any = "";
      let handle: any;
      try {
        const resolved: any = await resolvePluginWorkspacePath({
          workspaceRoot: boundedRoot,
          relativePath,
          fileSystem: source,
          forWrite: true
        });
        const parentPath: any = await ensurePluginWorkspaceParents({
          workspaceRoot: boundedRoot,
          normalizedPath: resolved.normalizedPath,
          fileSystem: source
        });
        const parentRealPath: any = await source.realpath(parentPath);
        const rootRealPath: any = await assertRegularWorkspaceRoot(boundedRoot, source);
        if (!pathIsWithinRoot(parentRealPath, rootRealPath)) {
          throw new Error("Plugin workspace parent is outside its boundary.");
        }
        temporaryPath = path.join(parentPath, `.meshrix-write-${randomUUID()}.tmp`);
        handle = await source.open(
          temporaryPath,
          fileConstants.O_WRONLY |
            fileConstants.O_CREAT |
            fileConstants.O_EXCL |
            fileConstants.O_NOFOLLOW,
          0o600
        );
        await handle.writeFile(String(content), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await source.rename(temporaryPath, resolved.absolutePath);
        temporaryPath = "";
        return Object.freeze({ ok: true });
      } catch {
        throw pluginWorkspaceAccessError("PLUGIN_WORKSPACE_WRITE_DENIED");
      } finally {
        await handle?.close().catch(() : any => {});
        if (temporaryPath) await source.unlink(temporaryPath).catch(() : any => {});
      }
    }
  });
}
