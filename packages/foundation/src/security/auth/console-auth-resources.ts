import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "../../storage/sqlite-database.ts";
import { createAuthorizationEngine } from "#meshrix/authorization-engine";
import { createAuthorizationGovernanceStore } from "../authorization/authorization-governance-store.ts";
import { createAuthorizationStore } from "../authorization/authorization-store.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.ts";
import { ensurePrivateDir } from "../../storage/private-file-atomic.ts";
import { ensureSchema } from "./console-auth-support.ts";

function closeOwnedResources(resources?: any, suppressErrors: any = false) : any {
  let firstCloseError: any;
  let hasCloseError: any = false;
  for (let index: any = resources.length - 1; index >= 0; index -= 1) {
    try {
      resources[index]?.close?.();
    } catch (error: any) {
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

function loadCsrfSecret(rootPath?: any) : any {
  const secretPath: any = path.join(rootPath, "csrf-hmac-secret.bin");
  try {
    const value: any = fs.readFileSync(secretPath);
    fs.chmodSync(secretPath, 0o600);
    return value;
  } catch {
    const csrfKeyBytes: any = crypto.randomBytes(32);
    fs.writeFileSync(secretPath, csrfKeyBytes, { mode: 0o600 });
    return csrfKeyBytes;
  }
}

export function createConsoleAuthResources({
  userDataPath,
  consoleRoles,
  tagManagementStore = null
}: Record<string, any>) : any {
  const rootPath: any = path.join(userDataPath, "auth");
  ensurePrivateDir(rootPath);
  const databasePath: any = ensurePrivateSqliteLocation(path.join(rootPath, "console-auth.sqlite"));
  const ownedResources: any[] = [];
  let db: any = null;
  let authorizationStore: any = null;
  let authorizationGovernanceStore: any = null;

  try {
    withPrivateFileCreationMask(() : any => {
      db = openSqliteDatabase(databasePath);
      ownedResources.push(db);
      ensureSchema(db);
      ensurePrivateSqliteLocation(databasePath);
    });

    authorizationStore = createAuthorizationStore({ userDataPath });
    ownedResources.push(authorizationStore);
    authorizationGovernanceStore = createAuthorizationGovernanceStore({
      userDataPath,
      builtinRoles: consoleRoles,
      tagManagementStore
    });
    ownedResources.push(authorizationGovernanceStore);
    const authorizationEngine: any = createAuthorizationEngine({
      store: authorizationStore,
      governanceStore: authorizationGovernanceStore
    });
    const csrfSecret: any = loadCsrfSecret(rootPath);
    const getUserByUsernameStmt: any = db.prepare("SELECT * FROM console_users WHERE username = ?");
    const getUserByIdStmt: any = db.prepare("SELECT * FROM console_users WHERE user_id = ?");
    const listUsersStmt: any = db.prepare("SELECT * FROM console_users ORDER BY created_at ASC, username ASC");
    const countUsersStmt: any = db.prepare("SELECT COUNT(*) AS count FROM console_users");
    const getSessionByTokenHashStmt: any = db.prepare(`
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
    const deleteSessionByIdStmt: any = db.prepare(
      "DELETE FROM console_sessions WHERE session_id = ?"
    );
    const deleteSessionByStateStmt: any = db.prepare(`
      DELETE FROM console_sessions
      WHERE session_id = ? AND token_hash = ? AND expires_at = ? AND last_seen_at = ?
    `);
    const touchSessionActivityStmt: any = db.prepare(
      `UPDATE console_sessions
       SET last_seen_at = ?
       WHERE session_id = ? AND token_hash = ? AND last_seen_at = ?`
    );
    let isClosed: any = false;

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
      close() : any {
        if (isClosed) {
          return;
        }
        isClosed = true;
        closeOwnedResources(ownedResources);
      }
    };
  } catch (error: any) {
    closeOwnedResources(ownedResources, true);
    throw error;
  }
}
