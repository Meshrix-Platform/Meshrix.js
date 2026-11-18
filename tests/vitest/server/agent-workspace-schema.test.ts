import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import {
  AGENT_WORKSPACE_MIGRATIONS,
  ensureAgentWorkspaceSchema,
  prepareAgentWorkspaceStatements
} from "../../../packages/agents/src/agent-workspace/agent-workspace-db.ts";
import { runMigrations } from "../../../packages/foundation/src/storage/sqlite-migrations.ts";

const CURRENT_WORKSPACE_COLUMNS: any[] = [
  "workspace_id",
  "title",
  "objective",
  "status",
  "parent_workspace_id",
  "profile_json",
  "owned_source_ids_json",
  "accessible_workspace_ids_json",
  "current_generation",
  "owner_user_id",
  "fs_path",
  "metadata_json",
  "created_at",
  "updated_at"
];

const CURRENT_TABLES: any[] = [
  "aw_artifacts",
  "aw_decisions",
  "aw_issues",
  "aw_locks",
  "aw_private_state",
  "aw_runs",
  "aw_session_events",
  "aw_sessions",
  "aw_submissions",
  "aw_workspaces"
];

describe("agent workspace schema", () : any => {
  it("creates the complete current schema in the initial transaction", () : any => {
    const db: any = new Database(":memory:");
    try {
      ensureAgentWorkspaceSchema(db);
      ensureAgentWorkspaceSchema(db);

      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aw_%' ORDER BY name")
          .all()
          .map((row?: any) : any => row.name)
      ).toEqual(CURRENT_TABLES);

      const columns: any = db.prepare("PRAGMA table_info(aw_workspaces)").all();
      expect(columns.map((column?: any) : any => column.name)).toEqual(CURRENT_WORKSPACE_COLUMNS);
      expect(Object.fromEntries(columns.map((column?: any) : any => [column.name, column.dflt_value]))).toMatchObject({
        profile_json: "'{}'",
        owned_source_ids_json: "'[]'",
        accessible_workspace_ids_json: "'[]'",
        current_generation: "1",
        owner_user_id: "''",
        fs_path: "''"
      });
      expect(() : any => prepareAgentWorkspaceStatements(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("backfills a root session and its creation event for workspaces that predate session roots", () : any => {
    const db: any = new Database(":memory:");
    try {
      const [initial, ...rest] = AGENT_WORKSPACE_MIGRATIONS;
      runMigrations(db, [initial]);
      db.prepare(
        "INSERT INTO aw_workspaces (workspace_id, title, objective, status, owner_user_id, metadata_json, created_at, updated_at, fs_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("ws-legacy", "Legacy workspace", "legacy objective", "active", "owner-1", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "");

      runMigrations(db, rest);

      const session: any = db
        .prepare("SELECT * FROM aw_sessions WHERE workspace_id = ? AND parent_session_id = ''")
        .get("ws-legacy");
      expect(session).toMatchObject({
        title: "Legacy workspace / 主会话",
        status: "active",
        created_by: "owner-1",
        event_count: 1
      });
      expect(JSON.parse(session.metadata_json)).toMatchObject({
        rootSession: true,
        generatedFromWorkspace: true
      });
      const event: any = db.prepare("SELECT * FROM aw_session_events WHERE session_id = ?").get(session.session_id);
      expect(event).toMatchObject({ event_type: "session_created", sequence: 1 });
      expect(session.last_event_id).toBe(event.event_id);
      expect(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_aw_artifacts_workspace', 'idx_aw_decisions_workspace')"
        ).all()
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("rolls back the complete initial schema when its final statement fails", () : any => {
    const db: any = new Database(":memory:");
    try {
      db.exec("CREATE TABLE idx_aw_session_events_workspace (sentinel TEXT)");

      expect(() : any => ensureAgentWorkspaceSchema(db)).toThrow();
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aw_%' ORDER BY name").all()
      ).toEqual([]);
      expect(
        db.prepare("SELECT type FROM sqlite_master WHERE name = 'idx_aw_session_events_workspace'").get()
      ).toEqual({ type: "table" });
    } finally {
      db.close();
    }
  });

  it("keeps the workspace store empty until an authorized create operation", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-explicit-workspace-"));
    const runtime: any = createAgentWorkspace({ userDataPath });
    try {
      expect(runtime.listWorkspaces({ canAccessAll: true }).workspaces).toEqual([]);
      const current: any = runtime.createWorkspace({
        title: "Explicit workspace",
        ownerUserId: "owner-fixture"
      }).workspace;
      const listed: any = runtime.listWorkspaces({ canAccessAll: true });

      expect(listed.workspaces).toHaveLength(1);
      expect(listed.workspaces[0]).toMatchObject({
        workspaceId: current.workspaceId,
        title: "Explicit workspace"
      });
      expect(listed.workspaces[0]).not.toHaveProperty("fsPath");
    } finally {
      runtime.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("refuses to delete a workspace when its persisted custody path escapes the managed folder root", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-delete-boundary-"));
    const outsidePath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-delete-outside-"));
    const runtime: any = createAgentWorkspace({ userDataPath });
    try {
      const workspace: any = runtime.createWorkspace({ title: "Boundary fixture" }).workspace;
      const db: any = new Database(path.join(userDataPath, "agent-workspaces", "agent-workspace.sqlite"));
      try {
        db.prepare("UPDATE aw_workspaces SET fs_path = ? WHERE workspace_id = ?")
          .run(outsidePath, workspace.workspaceId);
      } finally {
        db.close();
      }

      expect(runtime.deleteWorkspace(workspace.workspaceId, { canAccessAll: true })).toMatchObject({
        ok: false,
        code: "workspace_storage_boundary_invalid"
      });
      await expect(fs.access(outsidePath)).resolves.toBeUndefined();
    } finally {
      runtime.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });
});
