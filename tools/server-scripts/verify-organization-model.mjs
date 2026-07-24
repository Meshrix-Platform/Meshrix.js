#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createOrganizationModelStore,
  MESHRIX_ROOT_ORGANIZATION_ID,
  MESHRIX_ROOT_ORGANIZATION_LABEL
} from "../../packages/foundation/src/security/authorization/organization-model.mjs";
import { createConsoleAuth } from "../../packages/foundation/src/security/auth/console-auth.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";
import { listKernelCapabilityPermissions } from "#meshrix/authorization-engine";

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-organization-model-"));

try {
  const organizationStore = createOrganizationModelStore({ userDataPath });
  try {
    const root = organizationStore.getNode(MESHRIX_ROOT_ORGANIZATION_ID);
    assert.equal(root.nodeType, "root");
    assert.equal(root.label, MESHRIX_ROOT_ORGANIZATION_LABEL);
    assert.equal(root.parentId, "");
    assert.equal(root.metadata.authorizationBoundary, false);

    const engineering = organizationStore.upsertOrganization({
      organizationId: "org-engineering",
      label: "Engineering"
    });
    assert.equal(engineering.parentId, MESHRIX_ROOT_ORGANIZATION_ID);

    const platform = organizationStore.upsertOrganization({
      organizationId: "org-platform",
      parentId: engineering.nodeId,
      label: "Platform"
    });
    assert.deepEqual(
      organizationStore.pathForNode(platform.nodeId).map((node) => node.nodeId),
      [MESHRIX_ROOT_ORGANIZATION_ID, engineering.nodeId, platform.nodeId]
    );

    const owner = organizationStore.attachUser({
      userId: "user-owner",
      username: "owner",
      label: "Owner"
    });
    assert.equal(owner.parentId, MESHRIX_ROOT_ORGANIZATION_ID);
    assert.equal(owner.nodeType, "user");

    const alice = organizationStore.attachUser({
      userId: "user-alice",
      username: "alice",
      parentId: platform.nodeId
    });
    assert.equal(alice.parentId, platform.nodeId);

    assert.throws(
      () => organizationStore.upsertOrganization({ organizationId: "org-invalid", parentId: alice.nodeId }),
      /Users cannot have child/
    );
    assert.throws(
      () => organizationStore.moveNode(engineering.nodeId, platform.nodeId),
      /cycles/
    );
    assert.throws(
      () => organizationStore.moveNode(MESHRIX_ROOT_ORGANIZATION_ID, engineering.nodeId),
      /Meshrix Root cannot be moved/
    );
    assert.throws(
      () => organizationStore.upsertOrganization({ organizationId: MESHRIX_ROOT_ORGANIZATION_ID }),
      /reserved|immutable/
    );

    const summary = organizationStore.describeModel();
    assert.equal(summary.authorizationBoundary, false);
    assert.equal(summary.capabilityKernelBoundary, "excluded");
    assert.equal(summary.organizationCount, 2);
    assert.equal(summary.userCount, 2);
  } finally {
    organizationStore.close();
  }

  const tagManagementStore = createTagStoreAdapter({ userDataPath });
  const auth = createConsoleAuth({ userDataPath, tagManagementStore });
  try {
    const initialOwner = await auth.ensureInitialOwner();
    assert.equal(initialOwner.created, true);
    assert.equal(initialOwner.user.orgId, MESHRIX_ROOT_ORGANIZATION_ID);

    const user = await auth.createUser({
      username: "alice",
      password: "correct horse battery staple",
      roleId: "viewer"
    });
    assert.equal(user.orgId, MESHRIX_ROOT_ORGANIZATION_ID);

    const movedUser = await auth.updateUser(user.userId, { orgId: "org-platform" });
    assert.equal(movedUser.orgId, "org-platform");
    const rootUser = await auth.updateUser(user.userId, { orgId: "" });
    assert.equal(rootUser.orgId, MESHRIX_ROOT_ORGANIZATION_ID);
  } finally {
    auth.close();
    tagManagementStore.close();
  }

  assert.equal(
    listKernelCapabilityPermissions().some((capability) => capability.includes(MESHRIX_ROOT_ORGANIZATION_ID)),
    false,
    "Meshrix Root must not appear as a kernel capability permission"
  );

  console.log("organization model verifier passed");
} finally {
  await fs.rm(userDataPath, { recursive: true, force: true });
}
