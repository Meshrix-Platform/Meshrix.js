import { describe, expect, it } from "vitest";

import { ensureSchema as ensureConsoleAuthSchema } from "../../../packages/foundation/src/security/auth/console-auth-support.ts";
import { ensureSchema as ensureAuthorizationGovernanceSchema } from "../../../packages/foundation/src/security/authorization/authorization-governance-store-support.ts";
import { openSqliteDatabase } from "../../../packages/foundation/src/storage/sqlite-database.ts";
import { ensureTagManagementSchema } from "../../../packages/server-runtime/src/state/tag-management-schema.ts";

describe("canonical console role migration", () : any => {
  it("moves persisted console users and OIDC mappings to maintainer once", () : any => {
    const db: any = openSqliteDatabase(":memory:");
    db.exec(`
      CREATE TABLE console_users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role_id TEXT NOT NULL
      );
      CREATE TABLE console_oidc_config (
        config_id TEXT PRIMARY KEY,
        role_mapping_json TEXT NOT NULL
      );
      INSERT INTO console_users (user_id, username, role_id) VALUES
        ('legacy-admin', 'legacy-admin', 'admin'),
        ('legacy-operator', 'legacy-operator', 'operator'),
        ('auditor', 'auditor', 'viewer');
      INSERT INTO console_oidc_config (config_id, role_mapping_json) VALUES
        ('default', '{"ops":"operator","admins":"admin","audit":"viewer"}');
    `);

    ensureConsoleAuthSchema(db);

    expect(db.prepare("SELECT user_id, role_id FROM console_users ORDER BY user_id").all()).toEqual([
      { user_id: "auditor", role_id: "viewer" },
      { user_id: "legacy-admin", role_id: "maintainer" },
      { user_id: "legacy-operator", role_id: "maintainer" },
    ]);
    expect(JSON.parse(db.prepare("SELECT role_mapping_json FROM console_oidc_config").get().role_mapping_json)).toEqual({
      ops: "maintainer",
      admins: "maintainer",
      audit: "viewer",
    });
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });

  it("moves authorization user policies without retaining duplicate legacy roles", () : any => {
    const db: any = openSqliteDatabase(":memory:");
    db.exec(`
      CREATE TABLE authorization_user_policies (
        user_id TEXT PRIMARY KEY,
        role_ids_json TEXT NOT NULL
      );
      INSERT INTO authorization_user_policies (user_id, role_ids_json)
      VALUES ('subject', '["admin","operator","viewer"]');
    `);

    ensureAuthorizationGovernanceSchema(db);

    expect(JSON.parse(db.prepare("SELECT role_ids_json FROM authorization_user_policies").get().role_ids_json))
      .toEqual(["maintainer", "viewer"]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });

  it("removes obsolete role tags and projections while preserving other tags", () : any => {
    const db: any = openSqliteDatabase(":memory:");
    ensureTagManagementSchema(db);
    db.pragma("user_version = 0");
    const insertTag: any = db.prepare(`
      INSERT INTO tag_management_tags (
        tag_id, kind, label, description, parent_tag_id, enabled, system, status,
        scope_prerequisites_json, metadata_json, created_at, updated_at
      ) VALUES (?, 'role', ?, '', '', 1, 1, 'active', '[]', '{}', 'now', 'now')
    `);
    const insertProjection: any = db.prepare(`
      INSERT INTO tag_management_projections (tag_id, entity_type, entity_id, payload_json, updated_at)
      VALUES (?, 'authorization.role', ?, '{}', 'now')
    `);
    for (const roleId of ["admin", "operator", "viewer"]) {
      insertTag.run(`role:${roleId}`, roleId);
      insertProjection.run(`role:${roleId}`, roleId);
    }

    ensureTagManagementSchema(db);

    expect(db.prepare("SELECT tag_id FROM tag_management_tags ORDER BY tag_id").all())
      .toEqual([{ tag_id: "role:viewer" }]);
    expect(db.prepare("SELECT entity_id FROM tag_management_projections ORDER BY entity_id").all())
      .toEqual([{ entity_id: "viewer" }]);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });
});
