import { describe, expect, it, vi } from "vitest";

import {
  createMaintenanceAuthorizationAuthority
} from "../../../packages/agents/src/maintenance/authorization.ts";
import {
  executeMaintenanceAgentOperation
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts";

function grant(overrides: Record<string, any> = {}) : any {
  return {
    id: "grant-maintenance",
    enabled: true,
    revokedAt: "",
    expiresAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    scopes: ["maintenance:run", "maintenance:approve"],
    metadata: { policyRevision: 23 },
    projectionFingerprint: "a".repeat(64),
    policyIntegrity: { valid: true },
    ownerIntegrity: { valid: true },
    ...overrides
  };
}

function runtimeAuthorization(currentGrant: any = grant(), governanceRevision: any = 31) : any {
  return {
    ok: true,
    grant: currentGrant,
    policy: {
      decisionId: "policy-maintenance",
      governancePolicyRevision: {
        protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
        revision: governanceRevision,
        updatedAt: "2026-07-27T00:00:00.000Z"
      }
    }
  };
}

function fixture() : any {
  let currentGrant: any = grant();
  let governanceRevision: any = 31;
  let nowMs: any = Date.parse("2026-07-27T00:00:00.000Z");
  const store: Record<string, any> = {
    getGrant: vi.fn((grantId?: any) : any => grantId === currentGrant.id ? currentGrant : null)
  };
  const authority: any = createMaintenanceAuthorizationAuthority({
    operationPermissionStore: store,
    getGovernancePolicyRevision: () : any => ({ revision: governanceRevision }),
    now: () : any => nowMs,
    authorizationTtlMs: 60_000
  });
  return {
    authority,
    store,
    setGrant(next?: any) : any {
      currentGrant = next;
    },
    setGovernanceRevision(next?: any) : any {
      governanceRevision = next;
    },
    advance(ms?: any) : any {
      nowMs += ms;
    }
  };
}

describe("maintenance durable authorization", () : any => {
  it("forwards only the dispatcher-authenticated Grant context into run creation", async () : Promise<any> => {
    const authorization: any = runtimeAuthorization();
    const startRun: any = vi.fn(async (_input?: any, context?: any) : Promise<any> => ({
      status: "queued",
      grantId: context.operationAuthorization.grant.id
    }));
    const result: any = await executeMaintenanceAgentOperation({
      operationId: "maintenance_agent.runs.create",
      input: { runbook: "health_smoke" },
      context: {
        maintenanceAgent: { startRun },
        authSession: { user: { userId: "operator" } },
        request: { __meshrixToolRuntimeAuthorization: authorization }
      }
    });
    expect(result).toMatchObject({
      status: 200,
      payload: { status: "queued", grantId: "grant-maintenance" }
    });
    expect(startRun).toHaveBeenCalledWith(
      { runbook: "health_smoke" },
      expect.objectContaining({ operationAuthorization: authorization })
    );
  });

  it("binds the workload principal, current Grant projection, scope, revisions and expiry", async () : Promise<any> => {
    const subject: any = fixture();
    const binding: any = await subject.authority.capture({
      operationAuthorization: runtimeAuthorization(),
      requiredScope: "maintenance:run",
      plannedOperationIds: ["system.health", "runtime.info"],
      planHash: "b".repeat(64)
    });

    expect(binding).toMatchObject({
      protocolVersion: "v0.0.1:maintenance-agent:workload-authorization-1",
      workloadPrincipal: {
        subjectType: "agent-profile",
        subjectId: "maintenance-agent",
        profileId: "maintenance-agent"
      },
      grant: {
        grantId: "grant-maintenance",
        projectionFingerprint: "a".repeat(64),
        policyRevision: 23
      },
      policy: { governanceRevision: 31 },
      scope: {
        requiredScope: "maintenance:run",
        plannedOperationIds: ["runtime.info", "system.health"]
      },
      planHash: "b".repeat(64),
      expiresAt: "2026-07-27T00:01:00.000Z"
    });
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).resolves.toMatchObject({
      ok: true,
      workloadPrincipal: { subjectId: "maintenance-agent" }
    });
    await expect(subject.authority.revalidate(binding, {
      planHash: "c".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_authorization_binding_invalid"
    });
  });

  it("fails closed when the Grant is revoked, changed, expired, or loses scope", async () : Promise<any> => {
    const subject: any = fixture();
    const binding: any = await subject.authority.capture({
      operationAuthorization: runtimeAuthorization(),
      planHash: "b".repeat(64)
    });

    subject.setGrant(grant({ revokedAt: "2026-07-27T00:00:30.000Z" }));
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_grant_inactive"
    });

    subject.setGrant(grant({ projectionFingerprint: "b".repeat(64) }));
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_grant_changed"
    });

    subject.setGrant(grant({ scopes: ["maintenance:read"] }));
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_grant_scope_denied"
    });

    subject.setGrant(grant());
    subject.advance(60_001);
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_authorization_expired"
    });
  });

  it("fails closed when governance policy changes and rejects a synthetic actor", async () : Promise<any> => {
    const subject: any = fixture();
    const binding: any = await subject.authority.capture({
      operationAuthorization: runtimeAuthorization(),
      planHash: "b".repeat(64)
    });
    subject.setGovernanceRevision(32);
    await expect(subject.authority.revalidate(binding, {
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_policy_changed"
    });
    await expect(subject.authority.capture({
      operationAuthorization: {
        ok: true,
        grant: null,
        policy: runtimeAuthorization().policy
      },
      planHash: "b".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_current_grant_required"
    });
  });

  it("admits a schedule only through an explicitly configured current workload Grant", async () : Promise<any> => {
    const subject: any = fixture();
    const binding: any = await subject.authority.capture({
      configuredGrantId: "grant-maintenance",
      requiredScope: "maintenance:run",
      plannedOperationIds: ["system.health"],
      planHash: "d".repeat(64)
    });
    expect(binding).toMatchObject({
      grant: { grantId: "grant-maintenance" },
      policy: {
        decisionId: "configured-maintenance-workload-grant",
        governanceRevision: 31
      },
      planHash: "d".repeat(64)
    });
    await expect(subject.authority.capture({
      configuredGrantId: "missing-grant",
      requiredScope: "maintenance:run",
      planHash: "d".repeat(64)
    })).rejects.toMatchObject({
      code: "maintenance_grant_inactive"
    });
  });
});
