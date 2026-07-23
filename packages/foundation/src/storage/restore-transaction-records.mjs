import path from "node:path";
import {
  SQLITE_SIDECAR_SUFFIXES,
  isSqliteDataFile,
  isSqliteSidecar,
  safeRelativePath,
  storageError
} from "./backup-contract.mjs";
import {
  inspectStableFile,
  pathBoundaryReason,
  pathExists
} from "./storage-file-safety.mjs";

function recordFromAction(action, entry = null) {
  const operation = action.action === "delete" ? "delete" : "install";
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

async function sqliteSidecarRecords({ rootPath, entry, explicitPaths }) {
  if (!isSqliteDataFile(entry.relativePath)) return [];
  const records = [];
  const targetPath = path.join(rootPath, entry.relativePath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const relativePath = `${entry.relativePath}${suffix}`;
    if (explicitPaths.has(relativePath)) continue;
    const sidecarPath = `${targetPath}${suffix}`;
    if (!await pathExists(sidecarPath)) continue;
    const boundaryReason = await pathBoundaryReason({
      rootPath,
      targetPath: sidecarPath,
      allowMissingTarget: false
    });
    if (boundaryReason) {
      throw storageError("restore_target_changed", "A SQLite sidecar has an unsafe filesystem boundary.");
    }
    const current = await inspectStableFile(sidecarPath, { changedCode: "restore_target_changed" });
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

export async function buildRestoreTransactionRecords({ rootPath, entries, actions }) {
  const entryByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const mutableActions = actions.filter((action) => !["noop", "blocked"].includes(action.action));
  const explicitPaths = new Set(mutableActions.map((action) => action.relativePath));
  const records = [];
  for (const action of mutableActions.filter((item) => item.action === "delete" && isSqliteSidecar(item.relativePath))) {
    records.push(recordFromAction(action));
  }
  for (const action of mutableActions.filter((item) => ["create", "replace"].includes(item.action))) {
    const entry = entryByPath.get(action.relativePath);
    records.push(...await sqliteSidecarRecords({ rootPath, entry, explicitPaths }));
  }
  for (const action of mutableActions) {
    if (action.action === "delete" && isSqliteSidecar(action.relativePath)) continue;
    records.push(recordFromAction(action, entryByPath.get(action.relativePath)));
  }
  return records;
}
