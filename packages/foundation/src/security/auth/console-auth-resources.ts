import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "../../storage/sqlite-database.ts";
import { createAuthorizationEngine } from "#meshrix/authorization-engine";
import { createAuthorizationGovernanceStore } from "../authorization/authorization-governance-store.ts";
import {
  createAuthorizationStore,
  type AuthorizationStore
} from "../authorization/authorization-store.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.ts";
import { ensurePrivateDir } from "../../storage/private-file-atomic.ts";
import { ensureSchema } from "./console-auth-support.ts";

interface CloseableResource {
  close?: () => unknown | Promise<unknown>;
}

type GovernanceStore = ReturnType<typeof createAuthorizationGovernanceStore>;
type GovernanceOptions = NonNullable<Parameters<typeof createAuthorizationGovernanceStore>[0]>;

export interface ConsoleAuthResourceOptions {
  userDataPath: string;
  consoleRoles: NonNullable<GovernanceOptions["builtinRoles"]>;
  tagManagementStore?: GovernanceOptions["tagManagementStore"];
}

export interface ConsoleAuthResources {
  rootPath: string;
  db: Database.Database;
  authorizationStore: Readonly<AuthorizationStore>;
  authorizationGovernanceStore: ReturnType<typeof createAuthorizationGovernanceStore>;
  authorizationEngine: ReturnType<typeof createAuthorizationEngine>;
  csrfSecret: Buffer;
  getUserByUsernameStmt: Database.Statement<unknown[], ConsoleUserDbRow>;
  getUserByIdStmt: Database.Statement<unknown[], ConsoleUserDbRow>;
  listUsersStmt: Database.Statement<unknown[], ConsoleUserDbRow>;
  countUsersStmt: Database.Statement<unknown[], { count: number }>;
  getSessionByTokenHashStmt: Database.Statement<unknown[], ConsoleSessionDbRow>;
  deleteSessionByIdStmt: Database.Statement;
  deleteSessionByStateStmt: Database.Statement;
  touchSessionActivityStmt: Database.Statement;
  close(): Promise<void>;
}

export interface ConsoleUserDbRow extends Record<string, unknown> {
  user_id: string;
  username: string;
  display_name: string;
  role_id: string;
  password_hash: string;
  salt: string;
  enabled: number;
  tenant_id: string;
  org_id: string;
  team_ids_json: string;
  department_ids_json: string;
  allowed_workspace_ids_json: string;
  allowed_data_classes_json: string;
  allowed_egress_json: string;
  attributes_json: string;
  created_at: string;
  updated_at: string;
  last_login_at: string;
  failed_attempts: number;
  locked_until: string;
}

export interface ConsoleSessionDbRow extends ConsoleUserDbRow {
  session_id: string;
  user_agent_hash: string;
  last_seen_at: string;
  expires_at: string;
  token_hash: string;
  user_created_at: string;
  user_updated_at: string;
}

async function closeOwnedResources(
  resources: readonly CloseableResource[] = [],
  suppressErrors = false
): Promise<void> {
  let firstCloseError: unknown;
  let hasCloseError = false;
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    try {
      await resources[index]?.close?.();
    } catch (error) {
      if (!hasCloseError) {
        firstCloseError = error;
        hasCloseError = true;
      }
    }
  }
  if (!suppressErrors && hasCloseError) {
    throw firstCloseError;
  }
}

function closeConstructionResources(resources: readonly CloseableResource[] = []): void {
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    try {
      resources[index]?.close?.();
    } catch {
      // Preserve the synchronous construction failure while closing every
      // resource that was acquired before the authorization worker starts.
    }
  }
}

function loadCsrfSecret(rootPath: string): Buffer {
  const secretPath = path.join(rootPath, "csrf-hmac-secret.bin");
  try {
    const value = fs.readFileSync(secretPath);
    fs.chmodSync(secretPath, 0o600);
    return value;
  } catch {
    const csrfKeyBytes = crypto.randomBytes(32);
    fs.writeFileSync(secretPath, csrfKeyBytes, { mode: 0o600 });
    return csrfKeyBytes;
  }
}

export function createConsoleAuthResources({
  userDataPath,
  consoleRoles,
  tagManagementStore = null
}: ConsoleAuthResourceOptions): ConsoleAuthResources {
  const rootPath = path.join(userDataPath, "auth");
  ensurePrivateDir(rootPath);
  const databasePath = ensurePrivateSqliteLocation(path.join(rootPath, "console-auth.sqlite"));
  const constructionResources: CloseableResource[] = [];
  let authorizationStore: Readonly<AuthorizationStore> | null = null;

  try {
    const db = withPrivateFileCreationMask(() => {
      const openedDb = openSqliteDatabase(databasePath) as Database.Database;
      constructionResources.push(openedDb);
      ensureSchema(openedDb);
      ensurePrivateSqliteLocation(databasePath);
      return openedDb;
    }) as Database.Database;

    const authorizationGovernanceStore: GovernanceStore = createAuthorizationGovernanceStore({
      userDataPath,
      builtinRoles: consoleRoles,
      tagManagementStore
    });
    constructionResources.push(authorizationGovernanceStore);
    // Build the engine before starting the worker. Its sink delegates only
    // after this factory has returned, by which point authorizationStore is
    // guaranteed to be assigned.
    const authorizationEngine = createAuthorizationEngine({
      store: {
        appendDecision(decision?: Record<string, unknown>) {
          if (!authorizationStore) {
            throw new Error("Console authorization decision store is unavailable.");
          }
          return authorizationStore.appendDecision(decision);
        }
      },
      governanceStore: authorizationGovernanceStore
    });
    const csrfSecret = loadCsrfSecret(rootPath);
    const getUserByUsernameStmt = db.prepare<unknown[], ConsoleUserDbRow>("SELECT * FROM console_users WHERE username = ?");
    const getUserByIdStmt = db.prepare<unknown[], ConsoleUserDbRow>("SELECT * FROM console_users WHERE user_id = ?");
    const listUsersStmt = db.prepare<unknown[], ConsoleUserDbRow>("SELECT * FROM console_users ORDER BY created_at ASC, username ASC");
    const countUsersStmt = db.prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM console_users");
    const getSessionByTokenHashStmt = db.prepare<unknown[], ConsoleSessionDbRow>(`
      SELECT s.session_id, s.user_id, s.user_agent_hash, s.created_at,
             s.last_seen_at, s.expires_at,
             u.username, u.display_name, u.role_id, u.enabled,
             u.tenant_id, u.org_id, u.team_ids_json, u.department_ids_json,
             u.allowed_workspace_ids_json, u.allowed_data_classes_json,
             u.allowed_egress_json, u.attributes_json,
             u.created_at AS user_created_at, u.updated_at AS user_updated_at,
             u.last_login_at
      FROM console_sessions s
      JOIN console_users u ON u.user_id = s.user_id
      WHERE s.token_hash = ?
    `);
    const deleteSessionByIdStmt = db.prepare(
      "DELETE FROM console_sessions WHERE session_id = ?"
    );
    const deleteSessionByStateStmt = db.prepare(`
      DELETE FROM console_sessions
      WHERE session_id = ? AND token_hash = ? AND expires_at = ? AND last_seen_at = ?
    `);
    const touchSessionActivityStmt = db.prepare(
      `UPDATE console_sessions
       SET last_seen_at = ?
       WHERE session_id = ? AND token_hash = ? AND last_seen_at = ?`
    );
    // The asynchronous authorization worker is deliberately the final
    // construction step. No synchronous initialization can fail after it is
    // created, so constructor unwind never needs fire-and-forget worker close.
    authorizationStore = createAuthorizationStore({ userDataPath });
    const ownedResources: CloseableResource[] = [db, authorizationGovernanceStore, authorizationStore];
    let closePromise: Promise<void> | null = null;

    return {
      rootPath,
      db,
      authorizationStore,
      authorizationGovernanceStore,
      authorizationEngine,
      csrfSecret,
      getUserByUsernameStmt,
      getUserByIdStmt,
      listUsersStmt,
      countUsersStmt,
      getSessionByTokenHashStmt,
      deleteSessionByIdStmt,
      deleteSessionByStateStmt,
      touchSessionActivityStmt,
      close()  {
        if (!closePromise) {
          closePromise = closeOwnedResources(ownedResources);
        }
        return closePromise;
      }
    };
  } catch (error) {
    closeConstructionResources(constructionResources);
    throw error;
  }
}
