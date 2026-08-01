import path from "node:path";
import {
  SQLITE_SIDECAR_SUFFIXES,
  isSqliteDataFile,
  isSqliteSidecar,
  safeRelativePath,
  storageError
} from "./backup-contract.ts";
import {
  inspectStableFile,
  pathBoundaryReason,
  pathExists
} from "./storage-file-safety.ts";

function recordFromAction(action?: any, entry: any = null) : any {
  const operation: any = action.action === "delete" ? "delete" : "install";
  return {
    relativePath: safeRelativePath(action.relativePath),
    operation,
    hadOriginal: action.action !== "create",
    previousBytes: action.action === "create" ? 0 : action.currentBytes,
    previousSha256: action.action === "create" ? "" : action.currentSha256,
    installedBytes: operation === "install" ? entry.bytes : 0,
    installedSha256: operation === "install" ? entry.sha256 : "",
    sqlite: operation === "install" && isSqliteDataFile(entry.relativePath)
  };
}

async function sqliteSidecarRecords({ rootPath, entry, explicitPaths }: Record<string, any>) : Promise<any> {
  if (!isSqliteDataFile(entry.relativePath)) return [];
  const records: any[] = [];
  const targetPath: any = path.join(rootPath, entry.relativePath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const relativePath: any = `${entry.relativePath}${suffix}`;
    if (explicitPaths.has(relativePath)) continue;
    const sidecarPath: any = `${targetPath}${suffix}`;
    if (!await pathExists(sidecarPath)) continue;
    const boundaryReason: any = await pathBoundaryReason({
      rootPath,
      targetPath: sidecarPath,
      allowMissingTarget: false
    });
    if (boundaryReason) {
      throw storageError("restore_target_changed", "A SQLite sidecar has an unsafe filesystem boundary.");
    }
    const current: any = await inspectStableFile(sidecarPath, { changedCode: "restore_target_changed" });
    records.push({
      relativePath,
      operation: "delete",
      hadOriginal: true,
      previousBytes: current.bytes,
      previousSha256: current.sha256,
      installedBytes: 0,
      installedSha256: "",
      sqlite: false
    });
  }
  return records;
}

export async function buildRestoreTransactionRecords({ rootPath, entries, actions }: Record<string, any>) : Promise<any> {
  const entryByPath: any = new Map<any, any>(entries.map((entry?: any) : any => [entry.relativePath, entry]));
  const mutableActions: any = actions.filter((action?: any) : any => !["noop", "blocked"].includes(action.action));
  const explicitPaths: any = new Set<any>(mutableActions.map((action?: any) : any => action.relativePath));
  const records: any[] = [];
  for (const action of mutableActions.filter((item?: any) : any => item.action === "delete" && isSqliteSidecar(item.relativePath))) {
    records.push(recordFromAction(action));
  }
  for (const action of mutableActions.filter((item?: any) : any => ["create", "replace"].includes(item.action))) {
    const entry: any = entryByPath.get(action.relativePath);
    records.push(...await sqliteSidecarRecords({ rootPath, entry, explicitPaths }));
  }
  for (const action of mutableActions) {
    if (action.action === "delete" && isSqliteSidecar(action.relativePath)) continue;
    records.push(recordFromAction(action, entryByPath.get(action.relativePath)));
  }
  return records;
}
