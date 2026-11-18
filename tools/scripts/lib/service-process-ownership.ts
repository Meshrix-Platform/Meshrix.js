import path from "node:path";
import process from "node:process";

export interface MeshrixServiceProcessIdentity {
  pid: number;
  commandLine: string;
  workingDirectory?: string;
}

export interface MeshrixServiceOwnershipContext {
  selfPid: number;
  projectRoot: string;
  dataDirectory: string;
  globalClean?: boolean;
  caseInsensitivePaths?: boolean;
}

export function normalizeProcessPath(value: string, caseInsensitive = process.platform === "win32"): string {
  const resolver = /^[a-z]:[\\/]/iu.test(value) ? path.win32 : path;
  const normalized = resolver.resolve(value).replace(/\\/g, "/");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

const MESHRIX_ENTRYPOINTS = [
    "tools/server-scripts/start-server.ts",
    "tools/server-scripts/background-supervisor.ts",
    "tools/server-scripts/system-inspection-daemon.ts",
    "tools/scripts/start-all.ts",
    "tools/scripts/start-console.ts",
  ];

function commandText(commandLine: string, caseInsensitive: boolean): string {
  const normalized = commandLine.replace(/\\/g, "/");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isKnownMeshrixServiceCommand(commandLine: string): boolean {
  const text = commandText(commandLine, true);
  return MESHRIX_ENTRYPOINTS.some((entrypoint) => text.includes(entrypoint))
    || text.includes("/node_modules/.bin/vite")
    || text.includes(" node_modules/vite/")
    || /\bvite(\.cmd)?\b/.test(text);
}

function containsPathToken(text: string, target: string): boolean {
  let offset = text.indexOf(target);
  while (offset >= 0) {
    const before = offset === 0 ? "" : text[offset - 1];
    const after = text[offset + target.length] || "";
    const startsToken = offset === 0 || /[\s='"`]/u.test(before);
    const endsToken = after === "" || /[\s/'"`;,&]/u.test(after);
    if (startsToken && endsToken) return true;
    offset = text.indexOf(target, offset + 1);
  }
  return false;
}

function pathIsInside(value: string, root: string, caseInsensitive: boolean): boolean {
  const normalized = normalizeProcessPath(value, caseInsensitive);
  const normalizedRoot = normalizeProcessPath(root, caseInsensitive);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

function commandUsesDataDirectory(commandLine: string, dataDirectory: string, caseInsensitive: boolean): boolean {
  const text = commandText(commandLine, caseInsensitive);
  const normalizedDirectory = normalizeProcessPath(dataDirectory, caseInsensitive);
  const target = caseInsensitive ? normalizedDirectory.toLowerCase() : normalizedDirectory;
  return containsPathToken(text, `--data-dir ${target}`)
    || containsPathToken(text, `--data-dir=${target}`)
    || containsPathToken(text, `meshrix_server_data_dir=${target}`);
}

export function isMeshrixServiceProcessOwned(
  identity: MeshrixServiceProcessIdentity,
  context: MeshrixServiceOwnershipContext,
): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid === context.selfPid) return false;
  const caseInsensitive = context.caseInsensitivePaths ?? process.platform === "win32";
  const command = commandText(identity.commandLine, caseInsensitive);
  const entrypoint = MESHRIX_ENTRYPOINTS.some((name) => command.includes(name));
  const vite = command.includes("/node_modules/.bin/vite")
    || command.includes(" node_modules/vite/")
    || /\bvite(\.cmd)?\b/.test(command);
  if (!entrypoint && !vite) return false;
  if (context.globalClean && entrypoint) return true;

  const root = normalizeProcessPath(context.projectRoot, caseInsensitive);
  if (containsPathToken(command, root)) return true;
  if (entrypoint && commandUsesDataDirectory(identity.commandLine, context.dataDirectory, caseInsensitive)) return true;
  return Boolean(identity.workingDirectory && pathIsInside(identity.workingDirectory, context.projectRoot, caseInsensitive));
}
