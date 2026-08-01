import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ORGANIZATION_MODEL_PROTOCOL_VERSION,
  MESHRIX_ROOT_ORGANIZATION_ID,
  MESHRIX_ROOT_ORGANIZATION_LABEL,
  createOrganizationModelStore
} from "../../../packages/foundation/src/security/authorization/organization-model.ts";

const tempRoots: any[] = [];

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-org-model-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("organization model store behavior", () : any => {
  it("seeds root, upserts organizations and users, moves nodes, and persists metadata", async () : Promise<any> => {
    const rootPath: any = await tempRoot();
    const store: any = createOrganizationModelStore({ rootPath });

    expect(store.getNode(MESHRIX_ROOT_ORGANIZATION_ID)).toMatchObject({
      protocolVersion: ORGANIZATION_MODEL_PROTOCOL_VERSION,
      nodeId: MESHRIX_ROOT_ORGANIZATION_ID,
      nodeType: "root",
      label: MESHRIX_ROOT_ORGANIZATION_LABEL,
      metadata: { authorizationBoundary: false }
    });

    const engineering: any = store.upsertOrganization({
      organizationId: " engineering org ",
      label: "Engineering",
      metadata: { costCenter: "eng" }
    });
    expect(engineering).toMatchObject({
      nodeId: "engineering-org",
      nodeType: "organization",
      parentId: MESHRIX_ROOT_ORGANIZATION_ID,
      label: "Engineering",
      metadata: { costCenter: "eng" }
    });

    const platform: any = store.upsertOrganization({
      nodeId: "platform",
      parentOrganizationId: "engineering-org",
      name: "Platform"
    });
    const user: any = store.attachUser({
      userId: " user 1 ",
      organizationId: "platform",
      displayName: "Alice",
      username: "alice@example.test",
      metadata: { role: "admin" }
    });

    expect(platform.parentId).toBe("engineering-org");
    expect(user).toMatchObject({
      nodeId: "user-1",
      nodeType: "user",
      parentId: "platform",
      label: "Alice",
      username: "alice@example.test",
      metadata: { role: "admin" }
    });
    expect(store.listChildren("engineering-org").map((node?: any) : any => node.nodeId)).toEqual(["platform"]);
    expect(store.pathForNode("user-1").map((node?: any) : any => node.nodeId)).toEqual([
      MESHRIX_ROOT_ORGANIZATION_ID,
      "engineering-org",
      "platform",
      "user-1"
    ]);

    const moved: any = store.moveNode("user-1", "engineering-org");
    expect(moved.parentId).toBe("engineering-org");
    expect(store.pathForNode("user-1").map((node?: any) : any => node.nodeId)).toEqual([
      MESHRIX_ROOT_ORGANIZATION_ID,
      "engineering-org",
      "user-1"
    ]);

    const updated: any = store.attachUser({
      id: "user-1",
      orgId: "engineering-org",
      username: "alice2@example.test",
      metadata: "bad-metadata"
    });
    expect(updated).toMatchObject({
      label: "alice2@example.test",
      username: "alice2@example.test",
      metadata: {}
    });
    expect(updated.createdAt).toBe(user.createdAt);

    expect(store.describeModel()).toMatchObject({
      protocolVersion: ORGANIZATION_MODEL_PROTOCOL_VERSION,
      nodeCount: 4,
      organizationCount: 2,
      userCount: 1,
      authorizationBoundary: false,
      capabilityKernelBoundary: "excluded"
    });
    store.close();

    const reopened: any = createOrganizationModelStore({ rootPath });
    expect(reopened.getNode("user-1")).toMatchObject({
      username: "alice2@example.test",
      parentId: "engineering-org"
    });
    reopened.close();
  });

  it("rejects invalid node types, reserved root mutations, unknown parents, user children, and cycles", async () : Promise<any> => {
    const rootPath: any = await tempRoot();
    const store: any = createOrganizationModelStore({ rootPath });

    expect(() : any => store.upsertOrganization({ organizationId: MESHRIX_ROOT_ORGANIZATION_ID }))
      .toThrow("Meshrix Root id is reserved");
    expect(() : any => store.moveNode(MESHRIX_ROOT_ORGANIZATION_ID, MESHRIX_ROOT_ORGANIZATION_ID))
      .toThrow("Meshrix Root cannot be moved");
    expect(() : any => store.moveNode("missing", MESHRIX_ROOT_ORGANIZATION_ID))
      .toThrow("Unknown organization node");
    expect(() : any => store.upsertOrganization({ nodeId: "child", parentId: "missing" }))
      .toThrow("Unknown organization parent");

    const org: any = store.upsertOrganization({ id: "org-a", label: "Org A" });
    const child: any = store.upsertOrganization({ id: "org-b", parentId: org.nodeId, label: "Org B" });
    const user: any = store.attachUser({ id: "user-a", parentId: child.nodeId, username: "user-a" });

    expect(() : any => store.upsertOrganization({ id: "bad-child", parentId: user.nodeId }))
      .toThrow("Users cannot have child");
    expect(() : any => store.moveNode(org.nodeId, child.nodeId)).toThrow("cycles");

    expect(store.getNode("missing")).toBeNull();
    expect(store.listChildren("missing")).toEqual([]);
    expect(store.pathForNode("missing")).toEqual([]);
    store.close();
  });
});
