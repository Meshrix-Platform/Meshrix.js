import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_OPERATION_DEFINITIONS } from "#lico/contracts/operations/protocol-operation-definitions";
import { SERVER_API_OPERATIONS } from "#lico/contracts/operations/operation-registry";
import { operationFeatureId } from "#lico/contracts/operations/operation-feature-resolution";
import { CONSOLE_ROLES } from "../../packages/foundation/src/security/auth/console-auth.mjs";
import { createAuthorizationGovernanceStore } from "../../packages/foundation/src/security/authorization/authorization-governance-store.mjs";
import { createSecurityPermissionsProvider } from "../../packages/foundation/src/security/security-permissions-provider.mjs";
import { createToolCatalogRegistry } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-tag-management-"));

function repoPolicy(resourceId, actions = ["repo:write"], providers = ["github"]) {
  return {
    resourceType: "repo",
    resourceId,
    actions,
    targetProviders: providers
  };
}

try {
  const governance = createAuthorizationGovernanceStore({
    userDataPath,
    builtinRoles: CONSOLE_ROLES,
    tagManagementStore: createTagStoreAdapter({ userDataPath })
  });
  const tagStore = governance.tagManagementStore;
  assert.ok(tagStore, "tag management store should be attached to governance store");

  governance.upsertRole({
    roleId: "verify-role",
    label: "Verify Role",
    scopes: ["repo:read"],
    resourcePolicies: [repoPolicy("github:verify/repo")]
  });
  governance.upsertTeam({
    teamId: "verify-team",
    label: "Verify Team",
    roleIds: ["verify-role"],
    memberUserIds: ["user-verify"]
  });
  governance.upsertDepartment({
    departmentId: "verify-department",
    label: "Verify Department",
    roleIds: ["verify-role"],
    teamIds: ["verify-team"],
    memberUserIds: ["user-verify"]
  });
  governance.upsertAgentGroup({
    groupId: "verify-agent-group",
    label: "Verify Agent Group",
    resourcePolicies: [repoPolicy("github:verify/repo")]
  });
  governance.upsertAgentBinding({
    agentId: "verify-agent",
    boundUserId: "user-verify",
    groupIds: ["verify-agent-group"]
  });
  const roleTag = tagStore.getTag("role:verify-role");
  assert.equal(roleTag?.kind, "role");
  assert.deepEqual(
    roleTag?.metadata?.projections?.map(({ entityType, entityId }) => ({ entityType, entityId })),
    [{ entityType: "authorization.role", entityId: "verify-role" }]
  );
  assert.equal(tagStore.getProjection("authorization.role", "verify-role")?.payload.label, "Verify Role");
  assert.equal(governance.getRole("verify-role").label, "Verify Role");
  assert.equal(governance.listTeams().some((team) => team.teamId === "verify-team"), true);
  assert.equal(governance.listDepartments().some((department) => department.departmentId === "verify-department"), true);
  assert.equal(governance.listAgentGroups().some((group) => group.groupId === "verify-agent-group"), true);
  assert.equal(governance.listAgentBindings().some((binding) => binding.agentId === "verify-agent"), true);

  const baseRevision = tagStore.getPolicyRevision().revision;
  governance.close();
  tagStore.close();

  const governanceAgain = createAuthorizationGovernanceStore({
    userDataPath,
    builtinRoles: CONSOLE_ROLES,
    tagManagementStore: createTagStoreAdapter({ userDataPath })
  });
  const tagStoreAgain = governanceAgain.tagManagementStore;
  assert.equal(tagStoreAgain.getPolicyRevision().revision, baseRevision, "tag management policy revision should persist across reopen");

  governanceAgain.upsertRole({
    roleId: "verify-role",
    label: "Updated Through Tag Store",
    scopes: ["repo:read", "repo:write"]
  });
  assert.equal(governanceAgain.getRole("verify-role").label, "Updated Through Tag Store");

  const root = tagStoreAgain.upsertTag({
    tagId: "custom:root",
    kind: "custom",
    label: "Root",
    scopePrerequisites: ["auth:admin"]
  });
  const child = tagStoreAgain.upsertTag({
    tagId: "custom:child",
    kind: "custom",
    label: "Child",
    parentTagId: root.tagId,
    scopePrerequisites: ["repo:write"]
  });
  const leaf = tagStoreAgain.upsertTag({
    tagId: "custom:leaf",
    kind: "custom",
    label: "Leaf",
    parentTagId: child.tagId,
    scopePrerequisites: ["job:read"]
  });
  assert.deepEqual(tagStoreAgain.getEffectiveScopePrerequisites(child.tagId), ["auth:admin", "repo:write"]);
  assert.deepEqual(tagStoreAgain.getEffectiveScopePrerequisites(leaf.tagId), ["auth:admin", "repo:write", "job:read"]);
  assert.throws(
    () => tagStoreAgain.upsertTag({ ...child, parentTagId: child.tagId }),
    /parent itself|cycles/
  );
  assert.throws(
    () => tagStoreAgain.upsertTag({ ...root, parentTagId: leaf.tagId }),
    /cycles/
  );

  const archived = tagStoreAgain.archiveTag(child.tagId, { reason: "verify" });
  assert.equal(archived.status, "archived");
  assert.equal(archived.enabled, false);
  assert.equal(tagStoreAgain.listTags({ includeArchived: false }).some((tag) => tag.tagId === child.tagId), false);
  const restored = tagStoreAgain.restoreTag(child.tagId);
  assert.equal(restored.status, "active");
  assert.equal(restored.enabled, true);
  assert.throws(() => tagStoreAgain.archiveTag("role:admin"), /System tags cannot be archived/);

  const revisionAfterCrud = tagStoreAgain.getPolicyRevision().revision;
  assert.equal(revisionAfterCrud > baseRevision, true);
  const auditEvents = tagStoreAgain.listEvents({ limit: 20 }).map((event) => event.eventType);
  assert.ok(auditEvents.includes("create"));
  assert.ok(auditEvents.includes("archive"));
  assert.ok(auditEvents.includes("restore"));

  const securityPermissions = createSecurityPermissionsProvider({
    authorizationGovernanceStore: governanceAgain
  });
  securityPermissions.seedToolProfileTags([
    {
      id: "verify-tag-profile",
      label: "Verify Tag Profile",
      toolsets: ["lico.runtime.read"],
      maxRisk: "read_only"
    }
  ]);
  securityPermissions.seedToolProfileTags([
    {
      id: "verify-tag-profile",
      label: "Verify Tag Profile Duplicate",
      toolsets: ["lico.runtime.read"],
      maxRisk: "read_only"
    }
  ]);
  const toolProfiles = securityPermissions.listToolProfileTags();
  assert.equal(toolProfiles.some((profile) => profile.id === "verify-tag-profile"), true);
  assert.equal(
    tagStoreAgain.listProjections({ entityType: "operation-permission.profile" })
      .filter((projection) => projection.entityId === "verify-tag-profile").length,
    1
  );

  const registry = createToolCatalogRegistry({
    operations: SERVER_API_OPERATIONS,
    profiles: toolProfiles
  });
  assert.equal(registry.listProfiles().some((profile) => profile.id === "verify-tag-profile"), true);
  assert.equal(registry.getToolByOperationId("tag_management.tags.list")?.id, "lico.tagManagement.tags.list");
  assert.equal(registry.getToolByOperationId("tag_management.tags.upsert")?.requiredScopes.includes("auth:admin"), true);
  assert.equal(registry.getToolByOperationId("authorization.departments.list")?.id, "lico.authorization.departments.list");
  assert.equal(registry.getToolByOperationId("authorization.departments.upsert")?.requiredScopes.includes("auth:admin"), true);

  const tagOperations = SERVER_API_OPERATIONS.filter((operation) => operation.id.startsWith("tag_management."));
  assert.deepEqual(
    tagOperations.map((operation) => operation.id).sort(),
    [
      "tag_management.audit.list",
      "tag_management.projections.list",
      "tag_management.projections.rebuild",
      "tag_management.tags.archive",
      "tag_management.tags.get",
      "tag_management.tags.list",
      "tag_management.tags.restore",
      "tag_management.tags.upsert"
    ]
  );
  for (const operation of tagOperations) {
    assert.equal(operationFeatureId(operation), "tag-management");
    assert.deepEqual(operation.requiredScopes, ["auth:admin"]);
    if (operation.http.method !== "GET") {
      assert.equal(operation.safety.risk, "repair_write");
      assert.equal(operation.safety.requiresConfirmation, true);
    }
  }
  const protocolTagOperations = PROTOCOL_OPERATION_DEFINITIONS.filter((operation) => operation.id.startsWith("tag_management."));
  assert.deepEqual(
    tagOperations.map((operation) => operation.id).sort(),
    protocolTagOperations.map((operation) => operation.id).sort(),
    "current server registry must contain every tag management protocol operation"
  );

  const rebuild = securityPermissions.rebuildTagProjections();
  assert.equal(rebuild.count > 0, true);

  governanceAgain.close();
  tagStoreAgain.close();
  console.log("tag management verifier passed");
} finally {
  await fs.rm(userDataPath, { recursive: true, force: true });
}
