import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databases: any = vi.hoisted(() : any => []);
const DatabaseMock: any = vi.hoisted(() : any => vi.fn(function DatabaseFixture() : any {
  const database: any = databases.shift();
  if (!database) throw new Error("missing SQLite fixture");
  return database;
}));
const tempRoots: any[] = [];

vi.mock("better-sqlite3", () : any => ({ default: DatabaseMock }));

import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.ts";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.ts";
import { createSecurityAlertStore } from "../../../packages/foundation/src/security/security-alerts.ts";

function tempRoot() : any {
  const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-owned-sqlite-failure-"));
  tempRoots.push(root);
  return root;
}

function captureFailure(callback?: any) : any {
  try {
    callback();
  } catch (error: any) {
    return error;
  }
  throw new Error("expected constructor failure");
}

function schemaFailureDatabase(failure?: any, closeFailure: any = null) : any {
  return {
    exec: vi.fn(() : any => {
      throw failure;
    }),
    close: vi.fn(() : any => {
      if (closeFailure) throw closeFailure;
    })
  };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  databases.length = 0;
});

afterEach(() : any => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("owned SQLite constructor failure cleanup", () : any => {
  it("closes the owned work-queue database after statement preparation fails", () : any => {
    const failure: any = new Error("work queue statement setup failed");
    const database: Record<string, any> = {
      exec: vi.fn(),
      pragma: vi.fn(() : any => 0),
      transaction: vi.fn((work?: any) : any => (...args: any[]) : any => work(...args)),
      prepare: vi.fn(() : any => {
        throw failure;
      }),
      close: vi.fn(() : any => {
        throw new Error("work queue cleanup failed");
      })
    };
    databases.push(database);

    const thrown: any = captureFailure(() : any => createSqliteWorkQueueStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned tag-management database after statement preparation fails", () : any => {
    const failure: any = new Error("tag statement setup failed");
    const database: Record<string, any> = {
      exec: vi.fn(),
      pragma: vi.fn(() : any => 0),
      transaction: vi.fn((work?: any) : any => work),
      prepare: vi.fn(() : any => {
        throw failure;
      }),
      close: vi.fn(() : any => {
        throw new Error("tag cleanup failed");
      })
    };
    databases.push(database);

    const thrown: any = captureFailure(() : any => createTagManagementStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned security-alert database after schema initialization fails", () : any => {
    const failure: any = new Error("security alert schema failed");
    const database: any = schemaFailureDatabase(failure, new Error("security alert cleanup failed"));
    databases.push(database);

    const thrown: any = captureFailure(() : any => createSecurityAlertStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["work queue", (db?: any, root?: any) : any => createSqliteWorkQueueStore({ db, userDataPath: root })],
    ["tag management", (db?: any, root?: any) : any => createTagManagementStore({ db, userDataPath: root })],
    ["security alerts", (db?: any, root?: any) : any => createSecurityAlertStore({ db, userDataPath: root })]
  ])("does not close an injected %s database when construction fails", (_label?: any, createStore?: any) : any => {
    const failure: any = new Error("injected schema failed");
    const database: any = schemaFailureDatabase(failure);

    const thrown: any = captureFailure(() : any => createStore(database, tempRoot()));

    expect(thrown).toBe(failure);
    expect(database.close).not.toHaveBeenCalled();
    expect(DatabaseMock).not.toHaveBeenCalled();
  });
});
