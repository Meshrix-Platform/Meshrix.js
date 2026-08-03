import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.ts";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.ts";
import { createSecurityAlertStore } from "../../../packages/foundation/src/security/security-alerts.ts";

const tempRoots: any[] = [];

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-owned-sqlite-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("owned SQLite store lifecycle", () : any => {
  it("closes successful internally-owned stores idempotently", async () : Promise<any> => {
    const root: any = await tempRoot();
    const stores: any[] = [
      createSqliteWorkQueueStore({ userDataPath: path.join(root, "work-queue") }),
      createTagManagementStore({ userDataPath: path.join(root, "tag-management") }),
      createSecurityAlertStore({ userDataPath: path.join(root, "security-alerts") })
    ];

    for (const store of stores) {
      expect(store.isClosed()).toBe(false);
      store.close();
      expect(store.isClosed()).toBe(true);
      expect(() : any => store.close()).not.toThrow();
    }
  });

  it("never closes caller-owned injected databases", async () : Promise<any> => {
    const root: any = await tempRoot();
    const databases: any = Array.from({ length: 3 }, () : any => new Database(":memory:"));
    const stores: any[] = [
      createSqliteWorkQueueStore({ db: databases[0] }),
      createTagManagementStore({ db: databases[1], rootPath: path.join(root, "unused-tag-root") }),
      createSecurityAlertStore({ db: databases[2], userDataPath: path.join(root, "unused-alert-root") })
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
