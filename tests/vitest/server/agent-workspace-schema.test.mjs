import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.mjs";
import {
  ensureAgentWorkspaceSchema,
  prepareAgentWorkspaceStatements
} from "../../../packages/agents/src/agent-workspace/agent-workspace-db.mjs";

const CURRENT_WORKSPACE_COLUMNS = [
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

const CURRENT_TABLES = [
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

describe("agent workspace schema", () => {
  it("creates the complete current schema in the initial transaction", () => {
    const db = new Database(":memory:");
    try {
      ensureAgentWorkspaceSchema(db);
      ensureAgentWorkspaceSchema(db);

      expect(db.pragma("user_version", { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'aw_%' ORDER BY name")
          .all()
          .map((row) => row.name)
      ).toEqual(CURRENT_TABLES);

      const columns = db.prepare("PRAGMA table_info(aw_workspaces)").all();
      expect(columns.map((column) => column.name)).toEqual(CURRENT_WORKSPACE_COLUMNS);
      expect(Object.fromEntries(columns.map((column) => [column.name, column.dflt_value]))).toMatchObject({
        profile_json: "'{}'",
        owned_source_ids_json: "'[]'",
        accessible_workspace_ids_json: "'[]'",
        current_generation: "1",
        owner_user_id: "''",
        fs_path: "''"
      });
      expect(() => prepareAgentWorkspaceStatements(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("rolls back the complete initial schema when its final statement fails", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE idx_aw_session_events_workspace (sentinel TEXT)");

      expect(() => ensureAgentWorkspaceSchema(db)).toThrow();
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

  it("keeps the workspace store empty until an authorized create operation", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-explicit-workspace-"));
    const runtime = createAgentWorkspace({ userDataPath });
    try {
      expect(runtime.listWorkspaces({ canAccessAll: true }).workspaces).toEqual([]);
      const current = runtime.createWorkspace({
        title: "Explicit workspace",
        ownerUserId: "owner-fixture"
      }).workspace;
      const listed = runtime.listWorkspaces({ canAccessAll: true });

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

  it("refuses to delete a workspace when its persisted custody path escapes the managed folder root", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-delete-boundary-"));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-delete-outside-"));
    const runtime = createAgentWorkspace({ userDataPath });
    try {
      const workspace = runtime.createWorkspace({ title: "Boundary fixture" }).workspace;
      const db = new Database(path.join(userDataPath, "agent-workspaces", "agent-workspace.sqlite"));
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
