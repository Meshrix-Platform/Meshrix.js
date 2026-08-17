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
import type Database from "better-sqlite3";

type SchemaContributor =
  | ((db: Database.Database) => void)
  | { initialize(db: Database.Database): void };

interface StorageRuntimeLease {
  release(): void;
}

export interface StorageKernelSummary extends Record<string, unknown> {
  databasePath: string;
  objectRootPath: string;
  databaseExists: true;
  objectFileCount: number;
  objectBytes: number;
  objectCount: number;
  ownedObjectCount: number;
  deletionOperationCount: number;
  opaqueCustodyArtifactCount: number;
  opaqueCustodyPromotionCount: number;
}

interface StorageRowSummary {
  objectCount: number;
  ownedObjectCount: number;
  deletionOperationCount: number;
  opaqueCustodyArtifactCount: number;
  opaqueCustodyPromotionCount: number;
}

export interface StorageKernel {
  readonly databasePath: string;
  readonly objectRootPath: string;
  readonly db: Database.Database;
  readonly closed: boolean;
  getStorageSummary(): StorageKernelSummary;
  getUpgradePreflight(): unknown;
  close(): void;
}

function countRows(db: Database.Database, tableName: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    return row && typeof row === "object" && "count" in row ? Number(row.count || 0) : 0;
  } catch {
    return 0;
  }
}

function summarizeStorageRows(db: Database.Database): StorageRowSummary {
  return {
    objectCount: countRows(db, "storage_objects"),
    ownedObjectCount: countRows(db, "storage_object_owners"),
    deletionOperationCount: countRows(db, "storage_deletion_operations"),
    opaqueCustodyArtifactCount: countRows(db, "opaque_custody_artifacts"),
    opaqueCustodyPromotionCount: countRows(db, "opaque_custody_promotions")
  };
}

function summarizeFiles(rootPath: string): { fileCount: number; bytes: number } {
  let fileCount = 0;
  let bytes = 0;
  function walk(currentPath: string): void {
    let entries: fs.Dirent[] = [];
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
}: {
  userDataPath?: string;
  schemaContributors?: readonly SchemaContributor[];
} = {}): StorageKernel {
  const databasePath = getStorageDatabasePath(userDataPath);
  const runtimeLease = acquireStorageRuntimeLease(userDataPath) as StorageRuntimeLease;
  const dbHolder: { current: Database.Database | null } = { current: null };
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
      dbHolder.current = openSqliteDatabase(databasePath);
      initializeStorageSchema(dbHolder.current, { schemaContributors });
      ensurePrivateSqliteLocation(databasePath);
    });
  } catch (error: unknown) {
    try {
      dbHolder.current?.close();
    } catch {
      // Preserve the initialization failure while still attempting local cleanup.
    }
    runtimeLease.release();
    throw error;
  }

  const database = dbHolder.current;
  if (!database) {
    runtimeLease.release();
    throw new Error("Storage database initialization did not produce a database handle.");
  }
  let closed = false;

  return Object.freeze({
    get databasePath(): string {
      return getStorageDatabasePath(userDataPath);
    },
    get objectRootPath(): string {
      return getObjectRootPath(userDataPath);
    },
    get db(): Database.Database {
      return database;
    },
    get closed(): boolean {
      return closed;
    },
    getStorageSummary(): StorageKernelSummary {
      const files = summarizeFiles(getObjectRootPath(userDataPath));
      return {
        databasePath: getStorageDatabasePath(userDataPath),
        objectRootPath: getObjectRootPath(userDataPath),
        databaseExists: true,
        objectFileCount: files.fileCount,
        objectBytes: files.bytes,
        ...summarizeStorageRows(database)
      };
    },
    getUpgradePreflight(): unknown {
      return inspectStorageSchemaCompatibility(database);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        runtimeLease.release();
      }
    }
  });
}
