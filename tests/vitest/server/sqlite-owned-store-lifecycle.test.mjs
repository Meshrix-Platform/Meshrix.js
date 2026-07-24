import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.mjs";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.mjs";
import { createSecurityAlertStore } from "../../../packages/foundation/src/security/security-alerts.mjs";
import { createOrganizationModelStore } from "../../../packages/foundation/src/security/authorization/organization-model.mjs";

const tempRoots = [];

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-owned-sqlite-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("owned SQLite store lifecycle", () => {
  it("closes successful internally-owned stores idempotently", async () => {
    const root = await tempRoot();
    const stores = [
      createSqliteWorkQueueStore({ userDataPath: path.join(root, "work-queue") }),
      createTagManagementStore({ userDataPath: path.join(root, "tag-management") }),
      createSecurityAlertStore({ userDataPath: path.join(root, "security-alerts") }),
      createOrganizationModelStore({ rootPath: path.join(root, "organization-model") })
    ];

    for (const store of stores) {
      expect(store.isClosed()).toBe(false);
      store.close();
      expect(store.isClosed()).toBe(true);
      expect(() => store.close()).not.toThrow();
    }
  });

  it("never closes caller-owned injected databases", async () => {
    const root = await tempRoot();
    const databases = Array.from({ length: 4 }, () => new Database(":memory:"));
    const stores = [
      createSqliteWorkQueueStore({ db: databases[0] }),
      createTagManagementStore({ db: databases[1], rootPath: path.join(root, "unused-tag-root") }),
      createSecurityAlertStore({ db: databases[2], userDataPath: path.join(root, "unused-alert-root") }),
      createOrganizationModelStore({ db: databases[3], rootPath: path.join(root, "unused-org-root") })
    ];

    try {
      for (const [index, store] of stores.entries()) {
        store.close();
        store.close();
        expect(store.isClosed()).toBe(true);
        expect(databases[index].open).toBe(true);
      }
    } finally {
      for (const database of databases) {
        if (database.open) database.close();
      }
    }
  });
});
