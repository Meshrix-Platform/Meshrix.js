
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { controlledLocalSourceRoots } from "@meshrix/foundation/security/local-path-boundary";

const PATH_BROWSER_MAX_ENTRIES = 600;
const PATH_BROWSER_IGNORED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__"
]);

export function normalizePathBrowserMode(value) {
  return value === "file" ? "file" : "directory";
}

export function normalizePathBrowserExtensions(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
}

export function createPathBrowserRoots({ userDataPath, distPath } = {}) {
  const roots = new Map();
  const addRoot = (label, value) => {
    const nextPath = String(value || "").trim();
    if (!nextPath) {
      return;
    }
    const rootPathValue = path.resolve(nextPath);
    let realPath = rootPathValue;
    try {
      realPath = fsSync.realpathSync.native(rootPathValue);
    } catch {
      // Non-existent optional roots are still displayed but cannot authorize traversal.
    }
    const rootId = `path_root_${crypto.createHash("sha256").update(realPath).digest("hex").slice(0, 16)}`;
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

export function publicPathBrowserRoots(roots = []) {
  return roots.map((root) => ({
    rootId: root.id,
    label: root.label,
    path: pathBrowserVirtualPath(root)
  }));
}

export function normalizePathBrowserRelativePath(value = "", { allowEmpty = true } = {}) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || raw === ".") {
    if (allowEmpty) return "";
    throw new Error("路径不能为空。");
  }
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("路径必须是 rootId 内的相对路径。");
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === ".") {
    if (allowEmpty) return "";
    throw new Error("路径不能为空。");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("路径不能跳出 rootId。");
  }
  return normalized.replace(/^\/+/, "");
}

export function pathBrowserRelativePath(root = {}, absolutePath = "") {
  const relative = path.relative(path.resolve(root.path), path.resolve(absolutePath));
  if (!relative || relative === ".") return "";
  return relative.split(path.sep).join("/");
}

export function pathBrowserVirtualPath(root = {}, relativePath = "") {
  const normalized = normalizePathBrowserRelativePath(relativePath, { allowEmpty: true });
  return `${root.id || "path_root"}:/${normalized}`;
}

export function resolvePathBrowserVirtualPath(inputPath = "", roots = []) {
  const raw = String(inputPath || "").trim();
  const match = raw.match(/^([A-Za-z0-9_-]+):\/?(.*)$/);
  if (!match) return null;
  const root = roots.find((item) => item.id === match[1]);
  if (!root) return null;
  const relativePath = normalizePathBrowserRelativePath(match[2] || "", { allowEmpty: true });
  return {
    root,
    relativePath,
    absolutePath: relativePath ? path.resolve(root.path, ...relativePath.split("/")) : root.path
  };
}

export function resolvePathBrowserVirtualValue(value, roots = []) {
  if (Array.isArray(value)) {
    return value.map((item) => resolvePathBrowserVirtualValue(item, roots));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolvePathBrowserVirtualValue(child, roots)])
    );
  }
  if (typeof value === "string") {
    const virtual = resolvePathBrowserVirtualPath(value, roots);
    if (virtual) {
      return virtual.absolutePath;
    }
  }
  return value;
}

export function pathWithinRoot(candidatePath, rootPathValue) {
  const relative = path.relative(path.resolve(rootPathValue), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findPathBrowserRoot(candidatePath, roots = [], key = "path") {
  const matching = roots
    .filter((root) => pathWithinRoot(candidatePath, root[key] || root.path))
    .sort((left, right) => String(right[key] || right.path).length - String(left[key] || left.path).length);
  return matching[0] || null;
}

export async function realpathOrResolved(candidatePath) {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export async function resolvePathBrowserDirectory(inputPath, roots = []) {
  const requestedPath = String(inputPath || "").trim();
  const virtual = resolvePathBrowserVirtualPath(requestedPath, roots);
  const absolutePath = virtual
    ? virtual.absolutePath
    : path.resolve(requestedPath || roots[0]?.path || process.cwd());
  let directoryPath = absolutePath;
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      directoryPath = absolutePath;
    } else {
      directoryPath = path.dirname(absolutePath);
    }
  } catch {
    directoryPath = path.dirname(absolutePath);
  }
  const realDirectoryPath = await realpathOrResolved(directoryPath);
  if (
    findPathBrowserRoot(directoryPath, roots, "path") &&
    findPathBrowserRoot(realDirectoryPath, roots, "realPath")
  ) {
    return directoryPath;
  }
  return roots[0]?.path || process.cwd();
}

export async function statPathBrowserEntry({ absolutePath, name, mode, extensions, roots }) {
  const stats = await fs.lstat(absolutePath);
  const type = stats.isSymbolicLink() ? "other" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
  const extension = path.extname(name).toLowerCase();
  const fileAllowed = extensions.length === 0 || extensions.includes(extension);
  const realEntryPath = await realpathOrResolved(absolutePath);
  const root = findPathBrowserRoot(absolutePath, roots, "path");
  const withinAllowedRoot = Boolean(
    root &&
      findPathBrowserRoot(realEntryPath, roots, "realPath")
  );
  const relativePath = root ? pathBrowserRelativePath(root, absolutePath) : "";
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
}) {
  const roots = createPathBrowserRoots({ userDataPath, distPath });
  const currentPath = await resolvePathBrowserDirectory(requestedPath, roots);
  const currentRoot = findPathBrowserRoot(currentPath, roots, "path");
  const parentCandidate = path.dirname(currentPath);
  const parentPath =
    currentRoot && path.resolve(currentPath) !== path.resolve(currentRoot.path)
      ? parentCandidate
      : currentPath;
  let entries = [];
  let error = "";

  try {
    const directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });
    const names = directoryEntries
      .map((entry) => entry.name)
      .filter((name) => includeHidden || !name.startsWith("."))
      .filter((name) => !PATH_BROWSER_IGNORED_NAMES.has(name))
      .sort((left, right) => left.localeCompare(right, "zh-CN"));

    const listed = [];
    for (const name of names) {
      const absolutePath = path.join(currentPath, name);
      try {
        listed.push(await statPathBrowserEntry({ absolutePath, name, mode, extensions, roots }));
      } catch {
        // Ignore unreadable entries; the browser is for choosing paths, not diagnostics.
      }
      if (listed.length >= PATH_BROWSER_MAX_ENTRIES) {
        break;
      }
    }

    entries = listed.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  } catch (browseError) {
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
