import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "./sqlite-database.mjs";
import {
  getStorageDatabasePath,
  initializeStorageSchema
} from "./schema-manager.mjs";
import { getObjectRootPath } from "./object-store.mjs";
import { ensurePrivateDir } from "./private-file-atomic.mjs";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "./private-sqlite.mjs";
import { acquireStorageRuntimeLease } from "./storage-lifecycle-lock.mjs";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "./backup-contract.mjs";
import { reconcileStorageBackupCatalogSync } from "./backup-catalog.mjs";
import { reconcileStorageRetentionTransactionsSync } from "./backup-retention.mjs";
import { reconcileStorageRestoreTransactionsSync } from "./restore-transaction.mjs";

function countRows(db, tableName) {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0;
  } catch {
    return 0;
  }
}

function summarizeStorageRows(db) {
  return {
    objectCount: countRows(db, "storage_objects"),
    ownedObjectCount: countRows(db, "storage_object_owners"),
    deletionOperationCount: countRows(db, "storage_deletion_operations"),
    opaqueCustodyArtifactCount: countRows(db, "opaque_custody_artifacts"),
    opaqueCustodyPromotionCount: countRows(db, "opaque_custody_promotions")
  };
}

function summarizeFiles(rootPath) {
  let fileCount = 0;
  let bytes = 0;
  function walk(currentPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
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
} = {}) {
  const databasePath = getStorageDatabasePath(userDataPath);
  const runtimeLease = acquireStorageRuntimeLease(userDataPath);
  let db = null;
  try {
    reconcileStorageRestoreTransactionsSync(userDataPath);
    reconcileStorageRetentionTransactionsSync({ userDataPath });
    reconcileStorageBackupCatalogSync({
      userDataPath,
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION
    });
    ensurePrivateDir(getObjectRootPath(userDataPath));
    ensurePrivateSqliteLocation(databasePath);
    withPrivateFileCreationMask(() => {
      db = openSqliteDatabase(databasePath);
      initializeStorageSchema(db, { schemaContributors });
      ensurePrivateSqliteLocation(databasePath);
    });
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while still attempting local cleanup.
    }
    runtimeLease.release();
    throw error;
  }

  let closed = false;

  return Object.freeze({
    get databasePath() {
      return getStorageDatabasePath(userDataPath);
    },
    get objectRootPath() {
      return getObjectRootPath(userDataPath);
    },
    get db() {
      return db;
    },
    get closed() {
      return closed;
    },
    getStorageSummary() {
      const files = summarizeFiles(getObjectRootPath(userDataPath));
      return {
        databasePath: getStorageDatabasePath(userDataPath),
        objectRootPath: getObjectRootPath(userDataPath),
        databaseExists: true,
        objectFileCount: files.fileCount,
        objectBytes: files.bytes,
        ...summarizeStorageRows(db)
      };
    },
    close() {
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
