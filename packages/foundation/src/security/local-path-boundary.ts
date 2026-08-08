import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";

function text(value: any = "") : any {
  return String(value || "").trim();
}

function uniquePaths(values: any = []) : any {
  const seen: any = new Set<any>();
  const paths: any[] = [];
  for (const value of values) {
    const item: any = text(value);
    if (!item) continue;
    const resolved: any = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths;
}

function configuredRoots(envName: any = "MESHRIX_ALLOWED_LOCAL_SOURCE_ROOTS") : any {
  return uniquePaths(text(process.env[envName]).split(path.delimiter));
}

function dataRoot(userDataPath: any = "") : any {
  return path.resolve(text(userDataPath) || ServerConfig.getDataDir());
}

export function controlledLocalSourceRoots({ userDataPath = "", extraRoots = [] }: Record<string, any> = {}) : any {
  const root: any = dataRoot(userDataPath);
  return uniquePaths([
    path.join(root, "local-sources"),
    path.join(root, "agent-workspaces", "local-sources"),
    path.join(root, "gateway-sources", "local-sources"),
    ...configuredRoots(),
    ...extraRoots
  ]);
}

export function pathIsWithinRoot(candidatePath?: any, rootPath?: any) : any {
  const relative: any = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeSandboxRelativePath(value: any = "", { label = "虚拟路径" }: Record<string, any> = {}) : any {
  const raw: any = text(value).replace(/\\/g, "/");
  if (!raw || raw === ".") {
    return "";
  }
  if (raw.includes("\0")) {
    throw new Error(`${label}不能包含空字节。`);
  }
  let decoded: any = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  decoded = decoded.replace(/\\/g, "/");
  if (
    decoded.startsWith("/") ||
    /^[A-Za-z]:\//u.test(decoded) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(decoded)
  ) {
    throw new Error(`${label}必须是相对路径。`);
  }
  const segments: any[] = [];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error(`${label}不能跳出虚拟根目录。`);
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function resolveVirtualPathWithinRoot(rootPath: any = "", virtualPath: any = "", options: Record<string, any> = {}) : any {
  const root: any = path.resolve(rootPath);
  const relativePath: any = normalizeSandboxRelativePath(virtualPath, options);
  const absolutePath: any = path.resolve(root, ...relativePath.split("/").filter(Boolean));
  if (!pathIsWithinRoot(absolutePath, root)) {
    throw new Error(`${options.label || "虚拟路径"}不能跳出受控根目录。`);
  }
  return {
    rootPath: root,
    relativePath,
    absolutePath
  };
}

function rootPairsSync(roots: any = []) : any {
  return uniquePaths(roots).map((rootPath?: any) : any => {
    let realPath: any = rootPath;
    try {
      realPath = fsSync.realpathSync.native(rootPath);
    } catch {
      realPath = rootPath;
    }
    return { rootPath, realPath };
  });
}

async function rootPairs(roots: any = []) : Promise<any> {
  const pairs: any[] = [];
  for (const rootPath of uniquePaths(roots)) {
    let realPath: any = rootPath;
    try {
      realPath = await fs.realpath(rootPath);
    } catch {
      realPath = rootPath;
    }
    pairs.push({ rootPath, realPath });
  }
  return pairs;
}

function pathMatchesRootPairs(candidatePath?: any, realCandidatePath?: any, pairs: any = []) : any {
  return pairs.some((pair?: any) : any =>
    (pathIsWithinRoot(candidatePath, pair.rootPath) || pathIsWithinRoot(candidatePath, pair.realPath)) &&
    pathIsWithinRoot(realCandidatePath, pair.realPath)
  );
}

export function assertExistingLocalDirectoryWithinControlledRootsSync(sourcePath?: any, {
  userDataPath = "",
  allowedRoots = controlledLocalSourceRoots({ userDataPath }),
  label = "本机目录"
}: Record<string, any> = {}) : any {
  const rawPath: any = text(sourcePath);
  if (!rawPath) {
    throw new Error(`${label}路径不能为空。`);
  }
  const absolutePath: any = path.resolve(rawPath);
  const root: any = path.parse(absolutePath).root;
  if (absolutePath === root) {
    throw new Error(`不能把文件系统根目录作为${label}。`);
  }
  const stat: any = fsSync.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}不能是符号链接。`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label}必须是目录。`);
  }
  const realPath: any = fsSync.realpathSync.native(absolutePath);
  const pairs: any = rootPairsSync(allowedRoots);
  if (!pathMatchesRootPairs(absolutePath, realPath, pairs)) {
    throw new Error(`${label}必须位于 Meshrix.js 受控本机来源目录内。`);
  }
  return { absolutePath, realPath, stat, allowedRoots: pairs.map((pair?: any) : any => pair.rootPath) };
}

export async function assertExistingLocalDirectoryWithinControlledRoots(sourcePath?: any, {
  userDataPath = "",
  allowedRoots = controlledLocalSourceRoots({ userDataPath }),
  label = "本机目录"
}: Record<string, any> = {}) : Promise<any> {
  const rawPath: any = text(sourcePath);
  if (!rawPath) {
    throw new Error(`${label}路径不能为空。`);
  }
  const absolutePath: any = path.resolve(rawPath);
  const root: any = path.parse(absolutePath).root;
  if (absolutePath === root) {
    throw new Error(`不能把文件系统根目录作为${label}。`);
  }
  const stat: any = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}不能是符号链接。`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label}必须是目录。`);
  }
  const realPath: any = await fs.realpath(absolutePath);
  const pairs: any = await rootPairs(allowedRoots);
  if (!pathMatchesRootPairs(absolutePath, realPath, pairs)) {
    throw new Error(`${label}必须位于 Meshrix.js 受控本机来源目录内。`);
  }
  return { absolutePath, realPath, stat, allowedRoots: pairs.map((pair?: any) : any => pair.rootPath) };
}

export async function assertExistingLocalFileWithinControlledRoots(filePath?: any, {
  userDataPath = "",
  allowedRoots = controlledLocalSourceRoots({ userDataPath }),
  label = "本机文件"
}: Record<string, any> = {}) : Promise<any> {
  const rawPath: any = text(filePath);
  if (!rawPath) {
    throw new Error(`${label}路径不能为空。`);
  }
  const absolutePath: any = path.resolve(rawPath);
  const stat: any = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}不能是符号链接。`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label}必须是普通文件。`);
  }
  const realPath: any = await fs.realpath(absolutePath);
  const pairs: any = await rootPairs(allowedRoots);
  if (!pathMatchesRootPairs(absolutePath, realPath, pairs)) {
    throw new Error(`${label}必须位于 Meshrix.js 受控本机来源目录内。`);
  }
  return { absolutePath, realPath, stat, allowedRoots: pairs.map((pair?: any) : any => pair.rootPath) };
}

export async function assertWritablePathWithinRoot(rootPath?: any, targetPath?: any, { label = "目标路径" }: Record<string, any> = {}) : Promise<any> {
  const root: any = path.resolve(rootPath);
  const target: any = path.resolve(targetPath);
  if (!pathIsWithinRoot(target, root)) {
    throw new Error(`${label}不能跳出受控根目录。`);
  }
  const rootStat: any = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("受控根目录必须是普通目录。");
  }
  const rootRealPath: any = await fs.realpath(root);
  const relative: any = path.relative(root, target);
  const segments: any = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current: any = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat: any = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label}不能经过符号链接目录。`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`${label}父路径必须是目录。`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
  const parentPath: any = path.dirname(target);
  try {
    const parentRealPath: any = await fs.realpath(parentPath);
    if (!pathIsWithinRoot(parentRealPath, rootRealPath)) {
      throw new Error(`${label}真实父路径不能跳出受控根目录。`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    const stat: any = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}不能写入符号链接。`);
    }
    const realPath: any = await fs.realpath(target);
    if (!pathIsWithinRoot(realPath, rootRealPath)) {
      throw new Error(`${label}真实路径不能跳出受控根目录。`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { absolutePath: target, rootPath: root, rootRealPath };
}

export function assertPathWithinRootSync(rootPath?: any, targetPath?: any, {
  label = "目标路径",
  allowMissing = true,
  requireExisting = false,
  allowDirectory = true,
  allowFile = true,
  allowSpecial = false
}: Record<string, any> = {}) : any {
  const root: any = path.resolve(rootPath);
  const target: any = path.resolve(targetPath);
  if (!pathIsWithinRoot(target, root)) {
    throw new Error(`${label}不能跳出受控根目录。`);
  }
  const rootStat: any = fsSync.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("受控根目录必须是普通目录。");
  }
  const rootRealPath: any = fsSync.realpathSync.native(root);
  const relative: any = path.relative(root, target);
  const segments: any = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current: any = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat: any = fsSync.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label}不能经过符号链接目录。`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`${label}父路径必须是目录。`);
      }
      const realPath: any = fsSync.realpathSync.native(current);
      if (!pathIsWithinRoot(realPath, rootRealPath)) {
        throw new Error(`${label}真实父路径不能跳出受控根目录。`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        if (!allowMissing && requireExisting) {
          throw error;
        }
        break;
      }
      throw error;
    }
  }
  try {
    const stat: any = fsSync.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}不能指向符号链接。`);
    }
    if (stat.isDirectory() && !allowDirectory) {
      throw new Error(`${label}不能是目录。`);
    }
    if (stat.isFile() && !allowFile) {
      throw new Error(`${label}不能是文件。`);
    }
    if (!stat.isDirectory() && !stat.isFile() && !allowSpecial) {
      throw new Error(`${label}必须是普通文件或目录。`);
    }
    const realPath: any = fsSync.realpathSync.native(target);
    if (!pathIsWithinRoot(realPath, rootRealPath)) {
      throw new Error(`${label}真实路径不能跳出受控根目录。`);
    }
    return { absolutePath: target, rootPath: root, rootRealPath, exists: true, stat };
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (requireExisting || !allowMissing) {
      throw error;
    }
  }
  return { absolutePath: target, rootPath: root, rootRealPath, exists: false, stat: null };
}
