import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite-database.ts";
import {
  getStorageDatabasePath,
  inspectStorageSchemaCompatibility,
  initializeStorageSchema
} from "./schema-manager.ts";
import { getObjectRootPath } from "./object-store.ts";
import { ensurePrivateDir } from "./private-file-atomic.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "./private-sqlite.ts";
import { acquireStorageRuntimeLease } from "./storage-lifecycle-lock.ts";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "./backup-contract.ts";
import { reconcileStorageBackupCatalogSync } from "./backup-catalog.ts";
import { reconcileStorageRetentionTransactionsSync } from "./backup-retention.ts";
import { reconcileStorageRestoreTransactionsSync } from "./restore-transaction.ts";

function countRows(db?: any, tableName?: any) : any {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0;
  } catch {
    return 0;
  }
}

function summarizeStorageRows(db?: any) : any {
  return {
    objectCount: countRows(db, "storage_objects"),
    ownedObjectCount: countRows(db, "storage_object_owners"),
    deletionOperationCount: countRows(db, "storage_deletion_operations"),
    opaqueCustodyArtifactCount: countRows(db, "opaque_custody_artifacts"),
    opaqueCustodyPromotionCount: countRows(db, "opaque_custody_promotions")
  };
}

function summarizeFiles(rootPath?: any) : any {
  let fileCount: any = 0;
  let bytes: any = 0;
  function walk(currentPath?: any) : any {
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath: any = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          bytes += fs.statSync(absolutePath).size;
        } catch {
          // Files can disappear during live runtime scans.
        }
      }
    }
  }
  walk(rootPath);
  return { fileCount, bytes };
}

export function createStorageKernel({
  userDataPath,
  schemaContributors = []
}: Record<string, any> = {}) : any {
  const databasePath: any = getStorageDatabasePath(userDataPath);
  const runtimeLease: any = acquireStorageRuntimeLease(userDataPath);
  let db: any = null;
  try {
    reconcileStorageRestoreTransactionsSync(userDataPath);
    reconcileStorageRetentionTransactionsSync({ userDataPath });
    reconcileStorageBackupCatalogSync({
      userDataPath,
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION
    });
    ensurePrivateDir(getObjectRootPath(userDataPath));
    ensurePrivateSqliteLocation(databasePath);
    withPrivateFileCreationMask(() : any => {
      db = openSqliteDatabase(databasePath);
      initializeStorageSchema(db, { schemaContributors });
      ensurePrivateSqliteLocation(databasePath);
    });
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while still attempting local cleanup.
    }
    runtimeLease.release();
    throw error;
  }

  let closed: any = false;

  return Object.freeze({
    get databasePath() : any {
      return getStorageDatabasePath(userDataPath);
    },
    get objectRootPath() : any {
      return getObjectRootPath(userDataPath);
    },
    get db() : any {
      return db;
    },
    get closed() : any {
      return closed;
    },
    getStorageSummary() : any {
      const files: any = summarizeFiles(getObjectRootPath(userDataPath));
      return {
        databasePath: getStorageDatabasePath(userDataPath),
        objectRootPath: getObjectRootPath(userDataPath),
        databaseExists: true,
        objectFileCount: files.fileCount,
        objectBytes: files.bytes,
        ...summarizeStorageRows(db)
      };
    },
    getUpgradePreflight() : any {
      return inspectStorageSchemaCompatibility(db);
    },
    close() : any {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        runtimeLease.release();
      }
    }
  });
}
