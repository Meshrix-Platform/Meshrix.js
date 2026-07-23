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

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.mjs";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.mjs";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.mjs";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.mjs";
import { createAuthorizationGovernanceStore } from "../../../packages/foundation/src/security/authorization/authorization-governance-store.mjs";
import { createNoopTagStoreProvider } from "../../../packages/foundation/src/security/authorization/tag-store.port.mjs";
import { createClientRegistryService } from "../../../packages/server-runtime/src/state/client-registry-repository.mjs";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.mjs";
import { createWorkspaceAssetRegistry } from "../../../packages/agents/src/workspace-asset-registry/index.mjs";
import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.mjs";

function failingDatabase(message) {
  return {
    exec: vi.fn(() => {
      throw new Error(message);
    }),
    close: vi.fn()
  };
}

function databaseFixture({
  name = "",
  closeOrder = [],
  execError = null,
  prepareError = null,
  closeError = null
} = {}) {
  const statement = {
    all: vi.fn(() => []),
    get: vi.fn(() => null),
    run: vi.fn(() => ({ changes: 0 }))
  };
  return {
    exec: vi.fn(() => {
      if (execError) throw execError;
    }),
    transaction: vi.fn((work) => work),
    prepare: vi.fn(() => {
      if (prepareError) throw prepareError;
      return statement;
    }),
    close: vi.fn(() => {
      if (name) closeOrder.push(name);
      if (closeError) throw closeError;
    })
  };
}

function tagStoreFixture(userDataPath) {
  const roles = new Map();
  return {
    ...createNoopTagStoreProvider(),
    userDataPath,
    isClosed: vi.fn(() => false),
    getAuthorizationRole: vi.fn((roleId) => roles.get(roleId) || null),
    listAuthorizationRoles: vi.fn(() => [...roles.values()]),
    upsertAuthorizationRole: vi.fn((role) => {
      roles.set(role.roleId || role.id, role);
      return role;
    })
  };
}

function captureFailure(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected constructor failure");
}

function agentWorkspaceDatabaseWithStatementFailure(message) {
  return {
    pragma: vi.fn((statement) => statement === "user_version" ? 0 : undefined),
    transaction: vi.fn((work) => work),
    exec: vi.fn(),
    prepare: vi.fn(() => {
      throw new Error(message);
    }),
    close: vi.fn()
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

function tempUserDataPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lico-sqlite-constructor-unwind-"));
  tempRoots.push(root);
  return root;
}

describe("SQLite constructor unwind", () => {
  it("closes the storage database when schema initialization fails", () => {
    const database = failingDatabase("storage schema failed");
    databases.push(database);

    expect(() => createStorageKernel({ userDataPath: tempUserDataPath() }))
      .toThrow("storage schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned client-registry database when schema initialization fails", () => {
    const database = failingDatabase("client schema failed");
    databases.push(database);

    expect(() => createClientRegistryService({ userDataPath: tempUserDataPath() }))
      .toThrow("client schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the operation-audit database when schema initialization fails", () => {
    const database = failingDatabase("audit schema failed");
    databases.push(database);

    expect(() => createOperationAuditStore({ userDataPath: tempUserDataPath() }))
      .toThrow("audit schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the workspace-asset database when schema initialization fails", () => {
    const database = failingDatabase("workspace asset schema failed");
    databases.push(database);

    expect(() => createWorkspaceAssetRegistry({ userDataPath: tempUserDataPath() }))
      .toThrow("workspace asset schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the operation-permission database when schema initialization fails", () => {
    const database = failingDatabase("operation permission schema failed");
    databases.push(database);

    expect(() => createOperationPermissionStore({
      userDataPath: tempUserDataPath(),
      capabilityBindingGuard: false
    })).toThrow("operation permission schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("unwinds operation-permission security resources after a late construction failure", () => {
    const failure = new Error("operation permission statements failed");
    const capabilitySecurity = { close: vi.fn() };
    const database = {
      exec: vi.fn(),
      pragma: vi.fn(() => Number.MAX_SAFE_INTEGER),
      transaction: vi.fn((work) => work),
      prepare: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn()
    };
    databases.push(database);

    const thrown = captureFailure(() => createOperationPermissionStore({
      userDataPath: tempUserDataPath(),
      capabilityKeyProvider: capabilitySecurity,
      capabilityBindingGuard: capabilitySecurity
    }));

    expect(thrown).toBe(failure);
    expect(capabilitySecurity.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the agent-workspace database when construction fails after schema initialization", () => {
    const database = agentWorkspaceDatabaseWithStatementFailure("agent workspace statements failed");
    databases.push(database);

    expect(() => createAgentWorkspace({ userDataPath: tempUserDataPath() }))
      .toThrow("agent workspace statements failed");
    expect(database.exec).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the console-auth database when its schema initialization fails", () => {
    const failure = new Error("console auth schema failed");
    const database = databaseFixture({ execError: failure });
    databases.push(database);

    const thrown = captureFailure(() => createConsoleAuth({
      userDataPath: tempUserDataPath()
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the authorization-store database when its schema initialization fails", () => {
    const failure = new Error("authorization schema failed");
    const database = databaseFixture({
      execError: failure,
      closeError: new Error("authorization cleanup failed")
    });
    databases.push(database);

    const thrown = captureFailure(() => createAuthorizationStore({
      userDataPath: tempUserDataPath()
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the governance database when statement construction fails", () => {
    const userDataPath = tempUserDataPath();
    const failure = new Error("governance statement failed");
    const database = databaseFixture({
      prepareError: failure,
      closeError: new Error("governance cleanup failed")
    });
    databases.push(database);

    const thrown = captureFailure(() => createAuthorizationGovernanceStore({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("unwinds an authorization schema failure through Console Auth", () => {
    const userDataPath = tempUserDataPath();
    const closeOrder = [];
    const failure = new Error("authorization schema failed");
    const consoleDatabase = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase = databaseFixture({
      name: "authorization",
      closeOrder,
      execError: failure
    });
    databases.push(consoleDatabase, authorizationDatabase);

    const thrown = captureFailure(() => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(closeOrder).toEqual(["authorization", "console"]);
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("unwinds a governance schema failure through Console Auth in reverse ownership order", () => {
    const userDataPath = tempUserDataPath();
    const closeOrder = [];
    const failure = new Error("governance schema failed");
    const consoleDatabase = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase = databaseFixture({
      name: "governance",
      closeOrder,
      execError: failure
    });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const thrown = captureFailure(() => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(closeOrder).toEqual(["governance", "authorization", "console"]);
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("preserves a late Console Auth failure while attempting every reverse-order close", () => {
    const userDataPath = tempUserDataPath();
    const closeOrder = [];
    const constructionFailure = new Error("console statement failed");
    const closeFailure = new Error("governance close failed");
    const consoleDatabase = databaseFixture({
      name: "console",
      closeOrder,
      prepareError: constructionFailure
    });
    const authorizationDatabase = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase = databaseFixture({
      name: "governance",
      closeOrder,
      closeError: closeFailure
    });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const thrown = captureFailure(() => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(constructionFailure);
    expect(closeOrder).toEqual(["governance", "authorization", "console"]);
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("closes a successful Console Auth ownership tree only once", () => {
    const userDataPath = tempUserDataPath();
    const closeOrder = [];
    const consoleDatabase = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase = databaseFixture({ name: "governance", closeOrder });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const auth = createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    });
    expect(closeOrder).toEqual([]);

    auth.close();
    auth.close();

    expect(closeOrder).toEqual(["governance", "authorization", "console"]);
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("keeps successful authorization-store close operations idempotent", () => {
    const userDataPath = tempUserDataPath();
    const authorizationDatabase = databaseFixture();
    const governanceDatabase = databaseFixture();
    databases.push(authorizationDatabase, governanceDatabase);

    const authorizationStore = createAuthorizationStore({ userDataPath });
    const governanceStore = createAuthorizationGovernanceStore({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    });

    authorizationStore.close();
    authorizationStore.close();
    governanceStore.close();
    governanceStore.close();

    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
  });
});
