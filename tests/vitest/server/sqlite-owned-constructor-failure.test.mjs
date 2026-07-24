import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databases = vi.hoisted(() => []);
const DatabaseMock = vi.hoisted(() => vi.fn(function DatabaseFixture() {
  const database = databases.shift();
  if (!database) throw new Error("missing SQLite fixture");
  return database;
}));
const tempRoots = [];

vi.mock("better-sqlite3", () => ({ default: DatabaseMock }));

import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.mjs";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.mjs";
import { createSecurityAlertStore } from "../../../packages/foundation/src/security/security-alerts.mjs";
import { createOrganizationModelStore } from "../../../packages/foundation/src/security/authorization/organization-model.mjs";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-owned-sqlite-failure-"));
  tempRoots.push(root);
  return root;
}

function captureFailure(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected constructor failure");
}

function schemaFailureDatabase(failure, closeFailure = null) {
  return {
    exec: vi.fn(() => {
      throw failure;
    }),
    close: vi.fn(() => {
      if (closeFailure) throw closeFailure;
    })
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  databases.length = 0;
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("owned SQLite constructor failure cleanup", () => {
  it("closes the owned work-queue database after statement preparation fails", () => {
    const failure = new Error("work queue statement setup failed");
    const database = {
      exec: vi.fn(),
      pragma: vi.fn(() => 0),
      transaction: vi.fn((work) => (...args) => work(...args)),
      prepare: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn(() => {
        throw new Error("work queue cleanup failed");
      })
    };
    databases.push(database);

    const thrown = captureFailure(() => createSqliteWorkQueueStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned tag-management database after statement preparation fails", () => {
    const failure = new Error("tag statement setup failed");
    const database = {
      exec: vi.fn(),
      prepare: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn(() => {
        throw new Error("tag cleanup failed");
      })
    };
    databases.push(database);

    const thrown = captureFailure(() => createTagManagementStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned security-alert database after schema initialization fails", () => {
    const failure = new Error("security alert schema failed");
    const database = schemaFailureDatabase(failure, new Error("security alert cleanup failed"));
    databases.push(database);

    const thrown = captureFailure(() => createSecurityAlertStore({ userDataPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned organization-model database when root seeding fails", () => {
    const failure = new Error("organization root seed failed");
    const upsertStatement = {
      run: vi.fn(() => {
        throw failure;
      })
    };
    const queryStatement = { get: vi.fn(() => null) };
    const database = {
      exec: vi.fn(),
      prepare: vi.fn()
        .mockReturnValueOnce(upsertStatement)
        .mockReturnValueOnce(queryStatement),
      close: vi.fn(() => {
        throw new Error("organization cleanup failed");
      })
    };
    databases.push(database);

    const thrown = captureFailure(() => createOrganizationModelStore({ rootPath: tempRoot() }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["work queue", (db, root) => createSqliteWorkQueueStore({ db, userDataPath: root })],
    ["tag management", (db, root) => createTagManagementStore({ db, userDataPath: root })],
    ["security alerts", (db, root) => createSecurityAlertStore({ db, userDataPath: root })],
    ["organization model", (db, root) => createOrganizationModelStore({ db, rootPath: root })]
  ])("does not close an injected %s database when construction fails", (_label, createStore) => {
    const failure = new Error("injected schema failed");
    const database = schemaFailureDatabase(failure);

    const thrown = captureFailure(() => createStore(database, tempRoot()));

    expect(thrown).toBe(failure);
    expect(database.close).not.toHaveBeenCalled();
    expect(DatabaseMock).not.toHaveBeenCalled();
  });
});
