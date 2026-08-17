import path from "node:path";
import { ServerConfig } from "#meshrix/server-config";
import { readStorageBackupCatalog } from "./backup-catalog.ts";
import type { StorageBackupCatalog, StorageBackupCatalogEntry } from "./backup-catalog.ts";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "./backup-contract.ts";
import { rebuildStorageBackupCatalog } from "./backup-manifest.ts";

export interface StorageBackupList {
  schemaVersion: "v0.0.1:schema:definition-1";
  protocolVersion: string;
  catalogRevision: string;
  backups: readonly Readonly<StorageBackupCatalogEntry>[];
}

export async function listStorageBackups({
  userDataPath
}: { userDataPath?: string } = {}): Promise<StorageBackupList> {
  const rootPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  let catalog: StorageBackupCatalog | null = null;
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
