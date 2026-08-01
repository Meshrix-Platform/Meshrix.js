
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { controlledLocalSourceRoots } from "@meshrix/foundation/security/local-path-boundary";

const PATH_BROWSER_MAX_ENTRIES: any = 600;
const PATH_BROWSER_IGNORED_NAMES: any = new Set<any>([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__"
]);

export function normalizePathBrowserMode(value?: any) : any {
  return value === "file" ? "file" : "directory";
}

export function normalizePathBrowserExtensions(value?: any) : any {
  const items: any = Array.isArray(value) ? value : [];
  return items
    .map((item?: any) : any => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .map((item?: any) : any => (item.startsWith(".") ? item : `.${item}`));
}

export function createPathBrowserRoots({ userDataPath, distPath }: Record<string, any> = {}) : any {
  const roots: any = new Map<any, any>();
  const addRoot: any = (label?: any, value?: any) : any => {
    const nextPath: any = String(value || "").trim();
    if (!nextPath) {
      return;
    }
    const rootPathValue: any = path.resolve(nextPath);
    let realPath: any = rootPathValue;
    try {
      realPath = fsSync.realpathSync.native(rootPathValue);
    } catch {
      // Non-existent optional roots are still displayed but cannot authorize traversal.
    }
    const rootId: any = `path_root_${crypto.createHash("sha256").update(realPath).digest("hex").slice(0, 16)}`;
    roots.set(rootPathValue, {
      id: rootId,
      label,
      path: rootPathValue,
      realPath
    });
  };

  addRoot("当前项目", process.cwd());
  addRoot("Meshrix 数据目录", userDataPath);
  addRoot("Meshrix 前端构建", distPath);
  for (const root of controlledLocalSourceRoots({ userDataPath })) {
    addRoot("Meshrix 受控本机来源", root);
  }

  return [...roots.values()];
}

export function publicPathBrowserRoots(roots: any = []) : any {
  return roots.map((root?: any) : any => ({
    rootId: root.id,
    label: root.label,
    path: pathBrowserVirtualPath(root)
  }));
}

export function normalizePathBrowserRelativePath(value: any = "", { allowEmpty = true }: Record<string, any> = {}) : any {
  const raw: any = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || raw === ".") {
    if (allowEmpty) return "";
    throw new Error("路径不能为空。");
  }
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("路径必须是 rootId 内的相对路径。");
  }
  const normalized: any = path.posix.normalize(raw);
  if (!normalized || normalized === ".") {
    if (allowEmpty) return "";
    throw new Error("路径不能为空。");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("路径不能跳出 rootId。");
  }
  return normalized.replace(/^\/+/, "");
}

export function pathBrowserRelativePath(root: Record<string, any> = {}, absolutePath: any = "") : any {
  const relative: any = path.relative(path.resolve(root.path), path.resolve(absolutePath));
  if (!relative || relative === ".") return "";
  return relative.split(path.sep).join("/");
}

export function pathBrowserVirtualPath(root: Record<string, any> = {}, relativePath: any = "") : any {
  const normalized: any = normalizePathBrowserRelativePath(relativePath, { allowEmpty: true });
  return `${root.id || "path_root"}:/${normalized}`;
}

export function resolvePathBrowserVirtualPath(inputPath: any = "", roots: any = []) : any {
  const raw: any = String(inputPath || "").trim();
  const match: any = raw.match(/^([A-Za-z0-9_-]+):\/?(.*)$/);
  if (!match) return null;
  const root: any = roots.find((item?: any) : any => item.id === match[1]);
  if (!root) return null;
  const relativePath: any = normalizePathBrowserRelativePath(match[2] || "", { allowEmpty: true });
  return {
    root,
    relativePath,
    absolutePath: relativePath ? path.resolve(root.path, ...relativePath.split("/")) : root.path
  };
}

export function resolvePathBrowserVirtualValue(value?: any, roots: any = []) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => resolvePathBrowserVirtualValue(item, roots));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      (Object.entries(value) as [string, any][]).map(([key, child]: any[]) : any => [key, resolvePathBrowserVirtualValue(child, roots)])
    );
  }
  if (typeof value === "string") {
    const virtual: any = resolvePathBrowserVirtualPath(value, roots);
    if (virtual) {
      return virtual.absolutePath;
    }
  }
  return value;
}

export function pathWithinRoot(candidatePath?: any, rootPathValue?: any) : any {
  const relative: any = path.relative(path.resolve(rootPathValue), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findPathBrowserRoot(candidatePath?: any, roots: any = [], key: any = "path") : any {
  const matching: any = roots
    .filter((root?: any) : any => pathWithinRoot(candidatePath, root[key] || root.path))
    .sort((left?: any, right?: any) : any => String(right[key] || right.path).length - String(left[key] || left.path).length);
  return matching[0] || null;
}

export async function realpathOrResolved(candidatePath?: any) : Promise<any> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export async function resolvePathBrowserDirectory(inputPath?: any, roots: any = []) : Promise<any> {
  const requestedPath: any = String(inputPath || "").trim();
  const virtual: any = resolvePathBrowserVirtualPath(requestedPath, roots);
  const absolutePath: any = virtual
    ? virtual.absolutePath
    : path.resolve(requestedPath || roots[0]?.path || process.cwd());
  let directoryPath: any = absolutePath;
  try {
    const stats: any = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      directoryPath = absolutePath;
    } else {
      directoryPath = path.dirname(absolutePath);
    }
  } catch {
    directoryPath = path.dirname(absolutePath);
  }
  const realDirectoryPath: any = await realpathOrResolved(directoryPath);
  if (
    findPathBrowserRoot(directoryPath, roots, "path") &&
    findPathBrowserRoot(realDirectoryPath, roots, "realPath")
  ) {
    return directoryPath;
  }
  return roots[0]?.path || process.cwd();
}

export async function statPathBrowserEntry({ absolutePath, name, mode, extensions, roots }: Record<string, any>) : Promise<any> {
  const stats: any = await fs.lstat(absolutePath);
  const type: any = stats.isSymbolicLink() ? "other" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  const extension: any = path.extname(name).toLowerCase();
  const fileAllowed: any = extensions.length === 0 || extensions.includes(extension);
  const realEntryPath: any = await realpathOrResolved(absolutePath);
  const root: any = findPathBrowserRoot(absolutePath, roots, "path");
  const withinAllowedRoot: any = Boolean(
    root &&
      findPathBrowserRoot(realEntryPath, roots, "realPath")
  );
  const relativePath: any = root ? pathBrowserRelativePath(root, absolutePath) : "";
  return {
    name,
    rootId: root?.id || "",
    path: root ? pathBrowserVirtualPath(root, relativePath) : "",
    relativePath,
    type,
    byteSize: stats.isFile() ? stats.size : 0,
    modifiedAt: stats.mtime.toISOString(),
    hidden: name.startsWith("."),
    selectable:
      withinAllowedRoot &&
      ((mode === "directory" && type === "directory") ||
        (mode === "file" && type === "file" && fileAllowed)),
    browsable: withinAllowedRoot && type === "directory"
  };
}

export async function browseServerPath({
  requestedPath,
  mode,
  extensions,
  includeHidden,
  userDataPath,
  distPath
}: Record<string, any>) : Promise<any> {
  const roots: any = createPathBrowserRoots({ userDataPath, distPath });
  const currentPath: any = await resolvePathBrowserDirectory(requestedPath, roots);
  const currentRoot: any = findPathBrowserRoot(currentPath, roots, "path");
  const parentCandidate: any = path.dirname(currentPath);
  const parentPath: any =
    currentRoot && path.resolve(currentPath) !== path.resolve(currentRoot.path)
      ? parentCandidate
      : currentPath;
  let entries: any[] = [];
  let error: any = "";

  try {
    const directoryEntries: any = await fs.readdir(currentPath, { withFileTypes: true });
    const names: any = directoryEntries
      .map((entry?: any) : any => entry.name)
      .filter((name?: any) : any => includeHidden || !name.startsWith("."))
      .filter((name?: any) : any => !PATH_BROWSER_IGNORED_NAMES.has(name))
      .sort((left?: any, right?: any) : any => left.localeCompare(right, "zh-CN"));

    const listed: any[] = [];
    for (const name of names) {
      const absolutePath: any = path.join(currentPath, name);
      try {
        listed.push(await statPathBrowserEntry({ absolutePath, name, mode, extensions, roots }));
      } catch {
        // Ignore unreadable entries; the browser is for choosing paths, not diagnostics.
      }
      if (listed.length >= PATH_BROWSER_MAX_ENTRIES) {
        break;
      }
    }

    entries = listed.sort((left?: any, right?: any) : any => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  } catch (browseError: any) {
    error = browseError instanceof Error ? browseError.message : "无法读取目录。";
  }

  return {
    rootId: currentRoot?.id || "",
    currentPath: currentRoot ? pathBrowserVirtualPath(currentRoot, pathBrowserRelativePath(currentRoot, currentPath)) : "",
    parentPath: currentRoot && parentPath !== currentPath
      ? pathBrowserVirtualPath(currentRoot, pathBrowserRelativePath(currentRoot, parentPath))
      : "",
    mode,
    extensions,
    roots: publicPathBrowserRoots(roots),
    entries,
    truncated: entries.length >= PATH_BROWSER_MAX_ENTRIES,
    error
  };
}
