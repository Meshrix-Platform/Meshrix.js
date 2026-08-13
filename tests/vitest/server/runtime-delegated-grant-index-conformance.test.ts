import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOperationPermissionWorkerOwner } from "../../../packages/capabilities/src/operation-permission-core/store-worker-owner.ts";

const roots: string[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

async function createStore() : Promise<any> {
  const userDataPath: string = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-delegated-index-"));
  roots.push(userDataPath);
  const capabilityKeyProvider: any = {
    async issue({ credentialId }: Record<string, any>) : Promise<any> {
      return {
        capabilityKey: `ock_${credentialId}_bounded_fixture`,
        credentialId,
        capabilitySetHash: "fixture",
        capabilityCount: 1,
        expiresAt: "9999-12-31T23:59:59.999Z"
      };
    },
    async invalidateCredential() : Promise<any> {},
    close() : any {}
  };
  return createOperationPermissionWorkerOwner({
    userDataPath,
    capabilityKeyProvider,
    capabilityBindingGuard: false,
    capabilityResolver: () : any => ["cap:tool:*"]
  });
}

async function child(store?: any, id?: any, parentGrantId?: any) : Promise<any> {
  return store.createGrant({
    id,
    label: id,
    type: "delegated-mcp-child",
    capabilities: ["cap:tool:*"],
    metadata: { delegatedMcp: { sourceGrantId: parentGrantId } }
  });
}

describe("delegated grant parent index", () : any => {
  it("revokes deep and wide subtrees through one indexed recursive traversal", async () : Promise<any> => {
    const store: any = await createStore();
    try {
      const root: any = await store.createGrant({ id: "root", label: "root", capabilities: ["cap:tool:*"] });
      let parentId: string = root.grant.id;
      for (let index: number = 0; index < 40; index += 1) {
        const issued: any = await child(store, `deep-${index}`, parentId);
        parentId = issued.grant.id;
      }
      for (let index: number = 0; index < 80; index += 1) {
        await child(store, `wide-${index}`, root.grant.id);
      }

      const indexedPlan: any[] = store.db.prepare(`
        EXPLAIN QUERY PLAN SELECT id FROM tool_grants
        WHERE parent_grant_id = ? AND type = 'delegated-mcp-child'
      `).all(root.grant.id);
      expect(indexedPlan.some((row?: any) : any => String(row.detail).includes("idx_tool_grants_parent_type"))).toBe(true);

      await store.revokeGrant(root.grant.id, "indexed_subtree_test");
      expect(store.db.prepare("SELECT count(*) AS count FROM tool_grants WHERE enabled = 0").get().count).toBe(121);
      expect(store.db.prepare("PRAGMA user_version").get().user_version).toBe(14);
    } finally {
      store.close();
    }
  });

  it("fails closed when the explicit parent graph is corrupted into a cycle", async () : Promise<any> => {
    const store: any = await createStore();
    try {
      await store.createGrant({ id: "cycle-root", label: "root", capabilities: ["cap:tool:*"] });
      await child(store, "cycle-child", "cycle-root");
      store.db.prepare("UPDATE tool_grants SET type = 'delegated-mcp-child', parent_grant_id = ? WHERE id = ?")
        .run("cycle-child", "cycle-root");
      await expect(store.revokeGrant("cycle-root", "cycle_test"))
        .rejects.toThrow(/operation_permission_delegated_parent_cycle/u);
      expect(store.getGrant("cycle-child")).toMatchObject({ enabled: true, revokedAt: "" });
    } finally {
      store.close();
    }
  });
});
