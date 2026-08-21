import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS,
  ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
  createOrganizationGovernanceService,
  importOrganizationGovernanceTemplate,
  normalizeOrganizationGovernanceDraft
} from "../../../packages/foundation/src/security/authorization/organization-model.ts";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.ts";

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const value: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-org-template-"));
  roots.push(value);
  return value;
}
afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("organization governance TOML anti-corruption layer", () : any => {
  it("loads the file-backed enterprise catalog and explicit restricted roles", async () : Promise<any> => {
    const store: any = createTagManagementStore({ rootPath: await temporaryRoot() });
    const service: any = createOrganizationGovernanceService({ tagManagementStore: store });
    expect(service.listOrganizationGovernanceTemplates()).toEqual([
      expect.objectContaining({ templateKey: "enterprise-group", nodeCount: 5, tagCount: 5, roleCount: 5 })
    ]);
    const draft: any = service.importOrganizationGovernance({ templateKey: "enterprise-group" });
    expect(draft.schemaVersion).toBe(ORGANIZATION_TEMPLATE_SCHEMA_VERSION);
    expect(draft.organizationDepth).toBe(2);
    expect(draft.nodes.map((node?: any) : any => node.nodeType)).toEqual([
      "group", "organization", "organization", "department", "team"
    ]);
    expect(draft.roles.every((role?: any) : any =>
      JSON.stringify(role.managementActions) === JSON.stringify(ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS) &&
      role.businessResourceActions.length === 0 && role.assignedSubjectIds.length === 0)).toBe(true);
    expect(draft.roles.map((role?: any) : any => [role.scopeNodeId, role.managementActions])).toEqual([
      ["organization:group", [...ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS]],
      ["organization:primary", [...ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS]],
      ["organization:secondary", [...ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS]],
      ["group:department", [...ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS]],
      ["group:team", [...ORGANIZATION_GOVERNANCE_MANAGEMENT_ACTIONS]],
    ]);
    store.close();
  });

  it("imports one local TOML and derives graph depth without client authority", () : any => {
    const draft: any = importOrganizationGovernanceTemplate(`
schema_version = "v0.0.1:authorization:organization-template-1"
[template]
key = "local-example"
name = "Local example"
description = "Explicit local draft"
[[nodes]]
id = "organization:group"
type = "group"
parent = ""
name = "Group"
[[nodes]]
id = "group:department"
type = "department"
parent = "organization:group"
name = "Department"
[[tags]]
id = "organization:group"
kind = "organization"
label = "Group"
parent = ""
description = "Group scope"
scope_prerequisites = []
[[roles]]
id = "organization-administrator:group"
name = "Group administrator"
scope_node_id = "organization:group"
management_actions = ["organization.structure.read"]
`, "local.toml");
    expect(draft).toMatchObject({ templateKey: "local-example", organizationDepth: 0 });
  });

  it.each([
    ["unknown authority", { businessResourceActions: ["business:*"] }],
    ["subject assignment", { assignedSubjectIds: ["subject"] }],
    ["unsupported action", { managementActions: ["business.read"] }]
  ])("rejects %s", (_label?: any, rolePatch?: any) : any => {
    expect(() : any => normalizeOrganizationGovernanceDraft({
      schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
      templateKey: "invalid",
      templateName: "Invalid",
      description: "Invalid fixture",
      organizationDepth: 0,
      nodes: [{ nodeId: "group", nodeType: "group", parentId: "", name: "Group" }],
      tags: [],
      roles: [{
        roleId: "organization-administrator:group",
        name: "Administrator",
        scopeNodeId: "group",
        scopeNodeType: "group",
        managementActions: ["organization.structure.read"],
        businessResourceActions: [],
        assignedSubjectIds: [],
        ...rolePatch
      }]
    })).toThrowError(expect.objectContaining({ code: "organization_governance_invalid" }));
  });
});

describe("organization governance canonical tag-store aggregate", () : any => {
  it("starts empty and atomically publishes one revision-bound aggregate", async () : Promise<any> => {
    const store: any = createTagManagementStore({ rootPath: await temporaryRoot() });
    const service: any = createOrganizationGovernanceService({ tagManagementStore: store });
    const empty: any = service.getOrganizationGovernance();
    expect(empty).toMatchObject({ configured: false, revision: 0, nodes: [], tags: [], roles: [] });
    const draft: any = service.importOrganizationGovernance({ templateKey: "enterprise-group" });
    expect(service.previewOrganizationGovernance(draft)).toEqual(draft);
    expect(service.getOrganizationGovernance()).toEqual(empty);
    const published: any = service.publishOrganizationGovernance({ ...draft, expectedRevision: 0 });
    expect(published).toMatchObject({ configured: true, revision: 1, templateKey: "enterprise-group" });
    expect(store.listTags({ includeArchived: false }).map((tag?: any) : any => tag.tagId))
      .toEqual(expect.arrayContaining([...draft.tags.map((tag?: any) : any => tag.tagId), ...draft.roles.map((role?: any) : any => `role:${role.roleId}`)]));
    expect(store.listAuthorizationRoles({ includeDisabled: false })
      .filter((role?: any) : any => role.roleId.startsWith("organization-administrator:")))
      .toHaveLength(5);
    for (const role of draft.roles) {
      const scopeTag: any = draft.tags.find((tag?: any) : any => tag.tagId === role.scopeNodeId);
      expect(store.getTag(`role:${role.roleId}`)?.parentTagId).toBe(scopeTag.parentTagId);
    }
    expect(() : any => service.publishOrganizationGovernance({ ...draft, expectedRevision: 0 }))
      .toThrowError(expect.objectContaining({ code: "organization_governance_revision_conflict", currentRevision: 1 }));
    expect(service.getOrganizationGovernance()).toEqual(published);
    store.close();
  });

  it("rejects unmanaged tag and role collisions without mutating the aggregate", async () : Promise<any> => {
    const store: any = createTagManagementStore({ rootPath: await temporaryRoot() });
    const service: any = createOrganizationGovernanceService({ tagManagementStore: store });
    const draft: any = service.importOrganizationGovernance({ templateKey: "enterprise-group" });
    store.upsertTag({ tagId: draft.tags[0].tagId, kind: draft.tags[0].kind, label: "User managed" });
    expect(() : any => service.publishOrganizationGovernance({ ...draft, expectedRevision: 0 }))
      .toThrowError(expect.objectContaining({ code: "organization_governance_collision" }));
    expect(service.getOrganizationGovernance()).toMatchObject({ configured: false, revision: 0 });
    store.close();
  });
});

describe("tag change subscriber convergence", () : any => {
  it("serializes shared-root subscribers and returns the final publication receipt", async () : Promise<any> => {
    const root: any = await temporaryRoot();
    const subscriberStore: any = createTagManagementStore({ rootPath: root });
    const writerStore: any = createTagManagementStore({ rootPath: root });
    let releaseFirst: () => void = () : void => {};
    let reportFirstStarted: () => void = () : void => {};
    const firstBlocked: any = new Promise<void>((resolve?: any) : any => { releaseFirst = resolve; });
    const firstStarted: any = new Promise<void>((resolve?: any) : any => { reportFirstStarted = resolve; });
    const order: string[] = [];
    let invocation: any = 0;
    subscriberStore.registerChangeHandler(async () : Promise<any> => {
      invocation += 1;
      const current: any = invocation;
      order.push(`start:${current}`);
      if (current === 1) {
        reportFirstStarted();
        await firstBlocked;
      }
      order.push(`finish:${current}`);
      return Object.freeze({
        audienceRevision: current,
        affectedPartitions: Object.freeze([`partition-${current}`])
      });
    });
    try {
      writerStore.upsertTag({ tagId: "subscriber:first", kind: "custom", label: "First" });
      writerStore.upsertTag({ tagId: "subscriber:second", kind: "custom", label: "Second" });
      const drain: any = writerStore.drainChangeHandlers();
      await firstStarted;
      expect(order).toEqual(["start:1"]);
      releaseFirst();
      const receipt: any = await drain;
      expect(order).toEqual(["start:1", "finish:1", "start:2", "finish:2"]);
      expect(receipt).toMatchObject({ throughSequence: 2, eventCount: 2 });
      expect(receipt.lastEvent).toMatchObject({
        sequence: 2,
        eventType: "create",
        handlerCount: 1,
        subscriberResults: [{ audienceRevision: 2, affectedPartitions: ["partition-2"] }]
      });
    } finally {
      releaseFirst();
      writerStore.close();
      subscriberStore.close();
    }
  });

  it("propagates subscriber failure after the durable mutation and keeps the lane usable", async () : Promise<any> => {
    const root: any = await temporaryRoot();
    const subscriberStore: any = createTagManagementStore({ rootPath: root });
    const writerStore: any = createTagManagementStore({ rootPath: root });
    const subscriberFailure: any = new Error("subscriber fixture failure");
    const unregisterFailure: any = subscriberStore.registerChangeHandler(async () : Promise<any> => {
      throw subscriberFailure;
    });
    try {
      writerStore.upsertTag({ tagId: "subscriber:durable", kind: "custom", label: "Durable" });
      await expect(writerStore.drainChangeHandlers()).rejects.toMatchObject({
        name: "TagChangeSubscriberError",
        code: "tag_change_subscriber_failed",
        eventType: "create",
        failureCount: 1,
        cause: subscriberFailure
      });
      expect(writerStore.getTag("subscriber:durable")).toMatchObject({ label: "Durable" });

      unregisterFailure();
      subscriberStore.registerChangeHandler(async () : Promise<any> => ({
        audienceRevision: 2,
        affectedPartitions: ["partition-recovered"]
      }));
      writerStore.upsertTag({ tagId: "subscriber:recovered", kind: "custom", label: "Recovered" });
      await expect(writerStore.drainChangeHandlers()).resolves.toMatchObject({
        eventCount: 1,
        lastEvent: {
          subscriberResults: [{ audienceRevision: 2, affectedPartitions: ["partition-recovered"] }]
        }
      });
    } finally {
      writerStore.close();
      subscriberStore.close();
    }
  });
});
