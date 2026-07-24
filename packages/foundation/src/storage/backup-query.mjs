import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { readStorageBackupCatalog } from "./backup-catalog.mjs";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "./backup-contract.mjs";
import { rebuildStorageBackupCatalog } from "./backup-manifest.mjs";

export async function listStorageBackups({ userDataPath } = {}) {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  let catalog = null;
  try {
    catalog = await readStorageBackupCatalog({
      userDataPath: rootPath,
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION
    });
  } catch {
    // The catalog is rebuildable from validated backup manifests.
  }
  if (!catalog) {
    catalog = await rebuildStorageBackupCatalog({ userDataPath: rootPath });
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
    catalogRevision: catalog.revision,
    backups: catalog.backups
  };
}
