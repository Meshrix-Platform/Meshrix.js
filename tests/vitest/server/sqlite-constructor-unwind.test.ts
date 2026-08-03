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

import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.ts";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.ts";
import { createAuthorizationGovernanceStore } from "../../../packages/foundation/src/security/authorization/authorization-governance-store.ts";
import { createNoopTagStoreProvider } from "../../../packages/foundation/src/security/authorization/tag-store.port.ts";
import { createClientRegistryService } from "../../../packages/server-runtime/src/state/client-registry-repository.ts";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import { createWorkspaceAssetRegistry } from "../../../packages/agents/src/workspace-asset-registry/index.ts";
import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.ts";

function failingDatabase(message?: any) : any {
  return {
    exec: vi.fn(() : any => {
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
  closeError = null,
  migrationVersion = 0
}: Record<string, any> = {}) : any {
  const statement: Record<string, any> = {
    all: vi.fn(() : any => []),
    get: vi.fn(() : any => null),
    run: vi.fn(() : any => ({ changes: 0 }))
  };
  return {
    exec: vi.fn(() : any => {
      if (execError) throw execError;
    }),
    pragma: vi.fn(() : any => migrationVersion),
    transaction: vi.fn((work?: any) : any => work),
    prepare: vi.fn(() : any => {
      if (prepareError) throw prepareError;
      return statement;
    }),
    close: vi.fn(() : any => {
      if (name) closeOrder.push(name);
      if (closeError) throw closeError;
    })
  };
}

function tagStoreFixture(userDataPath?: any) : any {
  const roles: any = new Map<any, any>();
  return {
    ...createNoopTagStoreProvider(),
    userDataPath,
    isClosed: vi.fn(() : any => false),
    getAuthorizationRole: vi.fn((roleId?: any) : any => roles.get(roleId) || null),
    listAuthorizationRoles: vi.fn(() : any => [...roles.values()]),
    upsertAuthorizationRole: vi.fn((role?: any) : any => {
      roles.set(role.roleId || role.id, role);
      return role;
    })
  };
}

function captureFailure(callback?: any) : any {
  try {
    callback();
  } catch (error: any) {
    return error;
  }
  throw new Error("expected constructor failure");
}

function agentWorkspaceDatabaseWithStatementFailure(message?: any) : any {
  return {
    pragma: vi.fn((statement?: any) : any => statement === "user_version" ? 0 : undefined),
    transaction: vi.fn((work?: any) : any => work),
    exec: vi.fn(),
    prepare: vi.fn(() : any => {
      throw new Error(message);
    }),
    close: vi.fn()
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

function tempUserDataPath() : any {
  const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-sqlite-constructor-unwind-"));
  tempRoots.push(root);
  return root;
}

describe("SQLite constructor unwind", () : any => {
  it("closes the storage database when schema initialization fails", () : any => {
    const database: any = failingDatabase("storage schema failed");
    databases.push(database);

    expect(() : any => createStorageKernel({ userDataPath: tempUserDataPath() }))
      .toThrow("storage schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned client-registry database when schema initialization fails", () : any => {
    const database: any = failingDatabase("client schema failed");
    databases.push(database);

    expect(() : any => createClientRegistryService({ userDataPath: tempUserDataPath() }))
      .toThrow("client schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the operation-audit database when schema initialization fails", () : any => {
    const database: any = failingDatabase("audit schema failed");
    databases.push(database);

    expect(() : any => createOperationAuditStore({ userDataPath: tempUserDataPath() }))
      .toThrow("audit schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the workspace-asset database when schema initialization fails", () : any => {
    const database: any = failingDatabase("workspace asset schema failed");
    databases.push(database);

    expect(() : any => createWorkspaceAssetRegistry({ userDataPath: tempUserDataPath() }))
      .toThrow("workspace asset schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the operation-permission database when schema initialization fails", () : any => {
    const database: any = failingDatabase("operation permission schema failed");
    databases.push(database);

    expect(() : any => createOperationPermissionStore({
      userDataPath: tempUserDataPath(),
      capabilityBindingGuard: false
    })).toThrow("operation permission schema failed");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("unwinds operation-permission security resources after a late construction failure", () : any => {
    const failure: any = new Error("operation permission statements failed");
    const capabilitySecurity: Record<string, any> = { close: vi.fn() };
    const database: Record<string, any> = {
      exec: vi.fn(),
      pragma: vi.fn(() : any => Number.MAX_SAFE_INTEGER),
      transaction: vi.fn((work?: any) : any => work),
      prepare: vi.fn(() : any => {
        throw failure;
      }),
      close: vi.fn()
    };
    databases.push(database);

    const thrown: any = captureFailure(() : any => createOperationPermissionStore({
      userDataPath: tempUserDataPath(),
      capabilityKeyProvider: capabilitySecurity,
      capabilityBindingGuard: capabilitySecurity
    }));

    expect(thrown).toBe(failure);
    expect(capabilitySecurity.close).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the agent-workspace database when construction fails after schema initialization", () : any => {
    const database: any = agentWorkspaceDatabaseWithStatementFailure("agent workspace statements failed");
    databases.push(database);

    expect(() : any => createAgentWorkspace({ userDataPath: tempUserDataPath() }))
      .toThrow("agent workspace statements failed");
    expect(database.exec).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the console-auth database when its schema initialization fails", () : any => {
    const failure: any = new Error("console auth schema failed");
    const database: any = databaseFixture({ execError: failure });
    databases.push(database);

    const thrown: any = captureFailure(() : any => createConsoleAuth({
      userDataPath: tempUserDataPath()
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the authorization-store database when its schema initialization fails", () : any => {
    const failure: any = new Error("authorization schema failed");
    const database: any = databaseFixture({
      execError: failure,
      closeError: new Error("authorization cleanup failed")
    });
    databases.push(database);

    const thrown: any = captureFailure(() : any => createAuthorizationStore({
      userDataPath: tempUserDataPath()
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("closes the governance database when statement construction fails", () : any => {
    const userDataPath: any = tempUserDataPath();
    const failure: any = new Error("governance statement failed");
    const database: any = databaseFixture({
      prepareError: failure,
      closeError: new Error("governance cleanup failed")
    });
    databases.push(database);

    const thrown: any = captureFailure(() : any => createAuthorizationGovernanceStore({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("unwinds an authorization schema failure through Console Auth", () : any => {
    const userDataPath: any = tempUserDataPath();
    const closeOrder: any[] = [];
    const failure: any = new Error("authorization schema failed");
    const consoleDatabase: any = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase: any = databaseFixture({
      name: "authorization",
      closeOrder,
      execError: failure
    });
    databases.push(consoleDatabase, authorizationDatabase);

    const thrown: any = captureFailure(() : any => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(closeOrder).toEqual(["authorization", "console"]);
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("unwinds a governance schema failure through Console Auth in reverse ownership order", () : any => {
    const userDataPath: any = tempUserDataPath();
    const closeOrder: any[] = [];
    const failure: any = new Error("governance schema failed");
    const consoleDatabase: any = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase: any = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase: any = databaseFixture({
      name: "governance",
      closeOrder,
      execError: failure
    });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const thrown: any = captureFailure(() : any => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(failure);
    expect(closeOrder).toEqual(["governance", "authorization", "console"]);
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("preserves a late Console Auth failure while attempting every reverse-order close", () : any => {
    const userDataPath: any = tempUserDataPath();
    const closeOrder: any[] = [];
    const constructionFailure: any = new Error("console statement failed");
    const closeFailure: any = new Error("governance close failed");
    const consoleDatabase: any = databaseFixture({
      name: "console",
      closeOrder,
      prepareError: constructionFailure,
      migrationVersion: Number.MAX_SAFE_INTEGER
    });
    const authorizationDatabase: any = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase: any = databaseFixture({
      name: "governance",
      closeOrder,
      closeError: closeFailure
    });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const thrown: any = captureFailure(() : any => createConsoleAuth({
      userDataPath,
      tagManagementStore: tagStoreFixture(userDataPath)
    }));

    expect(thrown).toBe(constructionFailure);
    expect(closeOrder).toEqual(["governance", "authorization", "console"]);
    expect(governanceDatabase.close).toHaveBeenCalledOnce();
    expect(authorizationDatabase.close).toHaveBeenCalledOnce();
    expect(consoleDatabase.close).toHaveBeenCalledOnce();
  });

  it("closes a successful Console Auth ownership tree only once", () : any => {
    const userDataPath: any = tempUserDataPath();
    const closeOrder: any[] = [];
    const consoleDatabase: any = databaseFixture({ name: "console", closeOrder });
    const authorizationDatabase: any = databaseFixture({ name: "authorization", closeOrder });
    const governanceDatabase: any = databaseFixture({ name: "governance", closeOrder });
    databases.push(consoleDatabase, authorizationDatabase, governanceDatabase);

    const auth: any = createConsoleAuth({
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

  it("keeps successful authorization-store close operations idempotent", () : any => {
    const userDataPath: any = tempUserDataPath();
    const authorizationDatabase: any = databaseFixture();
    const governanceDatabase: any = databaseFixture();
    databases.push(authorizationDatabase, governanceDatabase);

    const authorizationStore: any = createAuthorizationStore({ userDataPath });
    const governanceStore: any = createAuthorizationGovernanceStore({
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
