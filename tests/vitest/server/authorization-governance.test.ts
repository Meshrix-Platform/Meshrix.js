import { describe, expect, it, vi } from "vitest";

import { AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS } from "../../../packages/contracts/src/operations/authorization-contribution-operation-definitions.ts";
import { OPERATION_REGISTRY_GOVERNED_DEFINITIONS } from "../../../packages/contracts/src/operations/operation-registry-governed-definitions.ts";
import { createSecurityPermissionsProvider } from "../../../packages/foundation/src/security/security-permissions-provider.ts";
import { openSqliteDatabase } from "../../../packages/foundation/src/storage/sqlite-database.ts";
import {
  createOrganizationGovernanceService
} from "../../../packages/foundation/src/security/authorization/organization-model.ts";
import { createSystemControllerFoundationHandlers } from "../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { executeAuthorizationFacadeOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/authorization-facade-executor.ts";
import { createTagManagementStore } from "../../../packages/server-runtime/src/state/tag-management-store.ts";

describe("organization governance operation contracts", () : any => {
  it("registers authenticated catalog, import, preview, and confirmed publish operations", () : any => {
    const operations: any[] = AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS.filter((operation?: any) : any =>
      operation.id.startsWith("authorization.organization_governance."));
    expect(operations.map((operation?: any) : any => [operation.id, operation.http.method, operation.http.path])).toEqual([
      ["authorization.organization_governance.get", "GET", "/api/authorization/organization-governance"],
      ["authorization.organization_governance.import", "POST", "/api/authorization/organization-governance/import"],
      ["authorization.organization_governance.preview", "POST", "/api/authorization/organization-governance/preview"],
      ["authorization.organization_governance.publish", "POST", "/api/authorization/organization-governance/publish"]
    ]);
    for (const operation of operations) {
      expect(operation.requiredScopes).toEqual(["auth:admin"]);
      expect(operation.inputSchema.additionalProperties).toBe(false);
    }
    expect(operations[1].readOnly).toBe(true);
    expect(operations[2].readOnly).toBe(true);
    expect(operations[3].safety).toMatchObject({
      risk: "repair_write",
      requiresConfirmation: true,
      approvalScope: "auth:admin"
    });
    expect(operations[3].audit).toMatchObject({ recordInput: false, metadataOnly: true });
    expect(operations[3].log).toMatchObject({ recordInput: false, redaction: "strict" });
    expect(operations[3].inputSchema.properties.nodes.items.additionalProperties).toBe(false);
    expect(operations[3].inputSchema.properties.roles.items.properties.businessResourceActions.maxItems).toBe(0);
    expect(OPERATION_REGISTRY_GOVERNED_DEFINITIONS
      .filter((operation?: any) : any => operation.id.startsWith("authorization.organization_governance."))
      .map((operation?: any) : any => operation.id)).toEqual(operations.map((operation?: any) : any => operation.id));
  });

  it("wires HTTP handlers to the exact frozen executor operation identifiers", async () : Promise<any> => {
    const sendConsoleDomainOperation: any = vi.fn(async () : Promise<any> => {});
    const handlers: any = createSystemControllerFoundationHandlers({
      sendConsoleDomainOperation,
      protocolPayload: (body?: any) : any => body,
      workspaceIdFrom: () : any => "",
      authorizationFacadeContext: () : any => ({ securityPermissions: {} }),
      accessControlContext: () : any => ({}),
      agentWorkspace: {},
      runtime: {}
    });
    const authSession: any = { user: { userId: "administrator" } };
    await handlers.handleAuthorizationOrganizationGovernanceGet({ response: {}, authSession });
    await handlers.handleAuthorizationOrganizationGovernanceImport({ requestBody: { templateKey: "enterprise-group" }, response: {}, authSession });
    await handlers.handleAuthorizationOrganizationGovernancePreview({ requestBody: { depth: 2 }, response: {}, authSession });
    await handlers.handleAuthorizationOrganizationGovernancePublish({ requestBody: { depth: 2 }, response: {}, authSession });
    expect(sendConsoleDomainOperation.mock.calls.map((call?: any) : any => call[0].operationId)).toEqual([
      "authorization.organization_governance.get",
      "authorization.organization_governance.import",
      "authorization.organization_governance.preview",
      "authorization.organization_governance.publish"
    ]);
  });
});

describe("organization governance facade", () : any => {
  it("composes the explicit organization store and returns truthful get/preview/publish results", async () : Promise<any> => {
    const db: any = openSqliteDatabase(":memory:");
    const tagManagementStore: any = createTagManagementStore({ db });
    const organizationGovernanceService: any = createOrganizationGovernanceService({ tagManagementStore });
    const securityPermissions: any = createSecurityPermissionsProvider({ organizationGovernanceService, tagManagementStore });
    const events: any[] = [];
    const context: any = {
      securityPermissions,
      authSession: { user: { userId: "administrator", roleId: "owner" } },
      protocolEventBus: { publish: async (topic?: any, payload?: any) : Promise<any> => {
        events.push({ topic, payload });
        return { id: `event-${events.length}`, offset: events.length, topic };
      } }
    };

    const getResult: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.get",
      context
    });
    expect(getResult.status).toBe(200);
    expect(getResult.payload.snapshot.configured).toBe(false);
    expect(getResult.payload.templates).toEqual([expect.objectContaining({ templateKey: "enterprise-group" })]);

    const importResult: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.import",
      input: { templateKey: "enterprise-group" },
      context
    });
    expect(importResult.status).toBe(200);
    const draft: any = importResult.payload.draft;
    const previewResult: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.preview",
      input: draft,
      context
    });
    expect(previewResult.status).toBe(200);
    expect(previewResult.payload.preview).not.toHaveProperty("revision");
    expect(securityPermissions.getOrganizationGovernance().revision).toBe(0);

    const publishResult: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.publish",
      input: { ...draft, expectedRevision: 0 },
      context
    });
    expect(publishResult.status).toBe(200);
    expect(publishResult.payload.snapshot.revision).toBe(1);
    expect(publishResult.payload).not.toHaveProperty("governanceUpdate");
    expect(events.map((event?: any) : any => event.topic)).toEqual([
      "authorization.governance.updated",
      "permissions.updated"
    ]);
    expect(events[0].payload.mutation).toEqual({
      entityType: "organization-governance",
      entityId: "organization-governance",
      eventType: "published"
    });
    const eventJson: any = JSON.stringify(events);
    expect(eventJson).not.toContain("organization-level-1");
    expect(eventJson).not.toContain("一级机构/子公司");
    expect(eventJson).not.toContain("administrator");
    tagManagementStore.close();
    db.close();
  });

  it("maps invalid, stale, and unavailable failures to the frozen bounded errors", async () : Promise<any> => {
    const db: any = openSqliteDatabase(":memory:");
    const tagManagementStore: any = createTagManagementStore({ db });
    const organizationGovernanceService: any = createOrganizationGovernanceService({ tagManagementStore });
    const securityPermissions: any = createSecurityPermissionsProvider({ organizationGovernanceService, tagManagementStore });
    const context: any = { securityPermissions };
    const draft: any = organizationGovernanceService.importOrganizationGovernance({ templateKey: "enterprise-group" });
    await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.publish",
      input: { ...draft, expectedRevision: 0 },
      context
    });
    const stale: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.publish",
      input: { ...draft, expectedRevision: 0 },
      context
    });
    expect(stale).toMatchObject({
      status: 409,
      payload: { code: "organization_governance_revision_conflict", currentRevision: 1 }
    });
    const invalid: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.preview",
      input: { ...draft, nodes: [...draft.nodes, draft.nodes[0]] },
      context
    });
    expect(invalid.status).toBe(400);
    expect(invalid.payload.code).toBe("organization_governance_invalid");
    expect(invalid.payload.issues.length).toBeGreaterThan(0);
    expect(invalid.payload.issues.length).toBeLessThanOrEqual(64);

    const unavailable: any = await executeAuthorizationFacadeOperation({
      operationId: "authorization.organization_governance.get",
      context: { securityPermissions: createSecurityPermissionsProvider() }
    });
    expect(unavailable).toMatchObject({
      status: 503,
      payload: { code: "organization_governance_unavailable" }
    });
    tagManagementStore.close();
    db.close();
  });
});
