import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  STORAGE_SCHEMA_REVISION,
  assertStorageSchemaUpgradePreflight,
  initializeStorageSchema,
  inspectStorageSchemaCompatibility
} from "../../../packages/foundation/src/storage/schema-manager.ts";

describe("storage schema upgrade preflight", () : any => {
  it("opens the primary metadata database with durable WAL commits", () : any => {
    const directory: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-storage-durability-"));
    const db: any = new Database(path.join(directory, "meshrix.sqlite"));
    try {
      initializeStorageSchema(db);

      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("initializes and records the current schema revision", () : any => {
    const db: any = new Database(":memory:");
    try {
      expect(inspectStorageSchemaCompatibility(db)).toMatchObject({
        ready: true,
        initializationRequired: true,
        currentRevision: 0,
        targetRevision: STORAGE_SCHEMA_REVISION
      });

      initializeStorageSchema(db);

      expect(inspectStorageSchemaCompatibility(db)).toMatchObject({
        ready: true,
        initializationRequired: false,
        metadataUpgradeRequired: false,
        currentRevision: STORAGE_SCHEMA_REVISION,
        targetRevision: STORAGE_SCHEMA_REVISION,
        missingCoreTableCount: 0,
        missingColumnCount: 0
      });
      expect(db.pragma("user_version", { simple: true })).toBe(STORAGE_SCHEMA_REVISION);
    } finally {
      db.close();
    }
  });

  it("adopts a structurally compatible unversioned database", () : any => {
    const db: any = new Database(":memory:");
    try {
      initializeStorageSchema(db);
      db.exec("DROP TABLE storage_schema_meta");
      db.pragma("user_version = 0");

      expect(inspectStorageSchemaCompatibility(db)).toMatchObject({
        ready: true,
        metadataUpgradeRequired: true,
        currentRevision: 0
      });

      initializeStorageSchema(db);
      expect(inspectStorageSchemaCompatibility(db).currentRevision).toBe(STORAGE_SCHEMA_REVISION);
    } finally {
      db.close();
    }
  });

  it("atomically upgrades the prior schema with the durable receipt table", () : any => {
    const db: any = new Database(":memory:");
    try {
      initializeStorageSchema(db);
      db.exec("DROP TABLE storage_upload_consumption_receipts");
      db.prepare(
        "UPDATE storage_schema_meta SET value = '1' WHERE key = 'schema_revision'"
      ).run();
      db.pragma("user_version = 1");

      expect(inspectStorageSchemaCompatibility(db)).toMatchObject({
        ready: true,
        currentRevision: 1,
        targetRevision: STORAGE_SCHEMA_REVISION,
        schemaUpgradeRequired: true,
        missingCoreTableCount: 1
      });

      initializeStorageSchema(db);

      expect(inspectStorageSchemaCompatibility(db)).toMatchObject({
        ready: true,
        currentRevision: STORAGE_SCHEMA_REVISION,
        schemaUpgradeRequired: false,
        missingCoreTableCount: 0
      });
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get("storage_upload_consumption_receipts")
      ).toEqual({ name: "storage_upload_consumption_receipts" });
    } finally {
      db.close();
    }
  });

  it("fails closed for a partial or future storage schema", () : any => {
    const partial: any = new Database(":memory:");
    try {
      partial.exec("CREATE TABLE storage_objects (object_id TEXT PRIMARY KEY)");
      expect(() : any => assertStorageSchemaUpgradePreflight(partial)).toThrow(
        expect.objectContaining({ code: "storage_schema_incompatible" })
      );
    } finally {
      partial.close();
    }

    const future: any = new Database(":memory:");
    try {
      initializeStorageSchema(future);
      future.prepare("UPDATE storage_schema_meta SET value = ? WHERE key = 'schema_revision'")
        .run(String(STORAGE_SCHEMA_REVISION + 1));
      expect(() : any => assertStorageSchemaUpgradePreflight(future)).toThrow(
        expect.objectContaining({ code: "storage_schema_future_revision" })
      );
    } finally {
      future.close();
    }
  });
});
