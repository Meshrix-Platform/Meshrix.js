import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPERATION_PROOF_PROFILES } from "#meshrix/contracts/operations/operation-decorators";
import { dispatchOperation } from "#meshrix/server-runtime/composition/dispatch-operation";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.ts";
import { createAuthorizationEngine } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";
import { createOperationAuditStore } from "../../../packages/foundation/src/security/operation-audit.ts";
import { createSecurityPermissionsProvider } from "../../../packages/foundation/src/security/security-permissions-provider.ts";
import { getProofLifecycleRefactorInstrumentation } from "../../../packages/server-runtime/src/composition/dispatch-operation-proof-lifecycle.ts";
import { auditOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-risk-control.ts";

const temporaryRoots: any = new Set<any>();

async function temporaryUserDataPath(prefix: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(userDataPath);
  return userDataPath;
}

afterEach(async () : Promise<any> => {
  for (const root of temporaryRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function createResponse() : any {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name?: any, value?: any) : any {
      this.headers[name] = value;
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    }
  };
}

function governedOperation(overrides: Record<string, any> = {}) : any {
  return {
    id: "unit.governed.evidence",
    target: { controller: "unit", method: "handle" },
    http: { method: "POST", path: "/api/unit/governed/evidence" },
    rpc: { method: "unit.governed.evidence" },
    concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
    readOnly: false,
    safety: { risk: "safe_write" },
    audit: { enabled: true },
    log: { recordInput: false },
    proof: { profile: OPERATION_PROOF_PROFILES.FULL, reason: "governed-evidence-test" },
    inputSchema: { type: "object", properties: {} },
    ...overrides
  };
}

function governedControllers(handler?: any) : any {
  return {
    unit: {
      handle: handler
    }
  };
}

function createProofSubstrate(overrides: Record<string, any> = {}) : any {
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "prepared-proof" })),
    finishLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "prepared-proof", disposition: "finished" })),
    recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "receipt-proof", disposition: "recorded" })),
    ...overrides
  };
}

const AUTHORIZED_SESSION: Readonly<Record<string, any>> = Object.freeze({
  sessionId: "governed-evidence-session",
  user: Object.freeze({
    type: "console-user",
    userId: "governed-evidence-subject",
    subjectId: "governed-evidence-subject",
    username: "governed-evidence-user",
    roleId: "owner",
    tenantId: "governed-evidence-tenant",
    scopes: Object.freeze(["runtime:write"])
  })
});

describe("runtime refactor governed proof and reference-based audit lifecycle", () : any => {
  it("stores one authorization decision and one reference-only denial row per denial", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-store-");
    const store: any = createAuthorizationStore({ userDataPath });
    try {
      const denied: any = await store.appendDecision({
        traceId: "trace-governed-deny",
        subject: { type: "user", subjectId: "subject-governed" },
        operation: { id: "unit.governed.evidence" },
        tool: { id: "tool-governed" },
        tenant: { resourceTenantId: "tenant-governed" },
        abac: { workspaceId: "workspace-governed" },
        action: "execute",
        effect: "deny",
        allowed: false,
        reasonCode: "policy_denied",
        missingScopes: ["runtime:write"],
        decision: {
          token: "Bearer secret-token",
          subjectCapabilities: ["cap-a", "cap-b"]
        },
        createdAt: "2026-08-11T00:00:00.000Z"
      });
      await store.appendDecision({
        traceId: "trace-governed-allow",
        subject: { type: "user", subjectId: "subject-governed" },
        operation: { id: "unit.governed.evidence" },
        effect: "allow",
        allowed: true,
        reasonCode: "allowed",
        decision: { ok: true },
        createdAt: "2026-08-11T00:00:01.000Z"
      });

      const decisions: any = await store.listDecisions({ operationId: "unit.governed.evidence", limit: 20 });
      expect(decisions).toHaveLength(2);

      const deniedRequests: any = await store.listDeniedRequests({
        subjectId: "subject-governed",
        operationId: "unit.governed.evidence",
        limit: 20
      });
      expect(deniedRequests).toHaveLength(1);
      expect(deniedRequests[0]).toMatchObject({
        decisionId: denied.decisionId,
        subjectId: "subject-governed",
        operationId: "unit.governed.evidence",
        toolId: "tool-governed",
        tenantId: "tenant-governed",
        workspaceId: "workspace-governed",
        reasonCode: "policy_denied"
      });
      expect(deniedRequests[0].deniedRequest).toMatchObject({
        decisionId: denied.decisionId,
        effect: "deny",
        allowed: false,
        reasonCode: "policy_denied"
      });
      expect(JSON.stringify(deniedRequests[0].deniedRequest)).toContain("<redacted>");
      const resolved: any = await store.listDeniedRequests({ reasonCode: "policy_denied", limit: 5 });
      expect(resolved[0].deniedRequest.decisionId).toBe(denied.decisionId);
      expect(JSON.stringify(resolved[0].deniedRequest)).toContain("<redacted>");

      const instrumentation: any = await store.getRefactorInstrumentation();
      expect(instrumentation.schemaVersion).toMatch(/authorization-denied-reference-store/);
      expect(instrumentation.deniedReferenceWrites).toBeGreaterThanOrEqual(1);
      expect(instrumentation.deniedReferencesResolved).toBeGreaterThanOrEqual(1);
    } finally {
      await store.close();
    }
  });

  it("transactionally deduplicates legacy denial rows and converts verified copies to references", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-migration-");
    let store: any = createAuthorizationStore({ userDataPath });
    let decisionId: any = "";
    let canonicalDecisionJson: any = "";
    try {
      const decision: any = await store.appendDecision({
        traceId: "trace-governed-legacy",
        subject: { type: "user", subjectId: "subject-legacy" },
        operation: { id: "unit.governed.evidence" },
        effect: "deny",
        allowed: false,
        reasonCode: "policy_denied",
        decision: { token: "Bearer legacy-secret" },
        createdAt: "2026-01-01T00:00:00.000Z"
      });
      decisionId = decision.decisionId;
      const decisions: any = await store.listDecisions({ operationId: "unit.governed.evidence", limit: 1 });
      canonicalDecisionJson = JSON.stringify(decisions[0].decision);
    } finally {
      await store.close();
    }

    const databasePath: any = path.join(userDataPath, "security", "authorization", "authorization.sqlite");
    const migrationFixture: any = new Database(databasePath);
    try {
      migrationFixture.exec("DROP INDEX idx_authorization_denied_decision_unique");
      const insertDuplicate: any = migrationFixture.prepare(`
        INSERT INTO authorization_denied_requests (
          denied_request_id, decision_id, subject_id, operation_id, tool_id, tenant_id, workspace_id, reason_code, denied_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertDuplicate.run(
        "legacy-denied-copy-1",
        decisionId,
        "subject-legacy",
        "unit.governed.evidence",
        "",
        "",
        "",
        "policy_denied",
        canonicalDecisionJson,
        "2020-01-01T00:00:00.000Z"
      );
      insertDuplicate.run(
        "legacy-denied-copy-2",
        decisionId,
        "subject-legacy",
        "unit.governed.evidence",
        "",
        "",
        "",
        "policy_denied",
        canonicalDecisionJson,
        "2020-01-02T00:00:00.000Z"
      );
      migrationFixture.pragma("user_version = 0");
    } finally {
      migrationFixture.close();
    }

    store = createAuthorizationStore({ userDataPath });
    try {
      const deniedRequests: any = await store.listDeniedRequests({ subjectId: "subject-legacy", limit: 20 });
      expect(deniedRequests).toHaveLength(1);
      expect(deniedRequests[0].decisionId).toBe(decisionId);
      expect(deniedRequests[0].deniedRequest).toMatchObject({
        decisionId,
        effect: "deny",
        allowed: false,
        reasonCode: "policy_denied"
      });
      expect(JSON.stringify(deniedRequests[0].deniedRequest)).toContain("<redacted>");
      const instrumentation: any = await store.getRefactorInstrumentation();
      expect(instrumentation.deniedDuplicateRowsRemoved).toBeGreaterThanOrEqual(2);
      expect(instrumentation.deniedRowsConverted).toBeGreaterThanOrEqual(1);
    } finally {
      await store.close();
    }
  });

  it("retains audit-unique fields, stores decision and proof references, and sheds duplicated terminal errors", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-audit-");
    const store: any = createOperationAuditStore({ userDataPath });
    try {
      await auditOperation({
        operationAuditStore: store,
        operation: governedOperation(),
        transport: "test",
        input: { password: "audit-secret-input" },
        status: "failed",
        error: "terminal-failure-copy",
        authorizationDecisionId: "decision-reference-1",
        proofId: "proof-reference-1"
      });
      await auditOperation({
        operationAuditStore: store,
        operation: governedOperation(),
        transport: "test",
        input: { password: "second-secret-input" },
        status: "failed",
        error: "unique-terminal-failure"
      });

      const records: any = await store.list({ limit: 10 });
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        decisionId: "",
        proofId: "",
        error: "unique-terminal-failure"
      });
      expect(records[0].redactedInput).toEqual({ password: "<redacted>" });
      expect(records[1]).toMatchObject({
        decisionId: "decision-reference-1",
        proofId: "proof-reference-1",
        error: ""
      });
      expect(records[1].redactedInput).toEqual({ password: "<redacted>" });
      expect(records[1].inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(records)).not.toContain("audit-secret-input");
      expect(JSON.stringify(records)).not.toContain("second-secret-input");

      const replayed: any = await store.appendIdempotent({
        auditId: records[1].auditId,
        operationId: "unit.governed.evidence",
        transport: "test",
        actor: { type: "anonymous" },
        risk: "safe_write",
        input: { password: "audit-secret-input" },
        status: "failed",
        error: "terminal-failure-copy",
        decisionId: "decision-reference-1",
        proofId: "proof-reference-1"
      });
      expect(replayed.replayed).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("writes one decision, one proof settlement, and one reference-bound audit row for an allowed governed execution", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-dispatch-");
    const authorizationStore: any = createAuthorizationStore({ userDataPath });
    const auditStore: any = createOperationAuditStore({ userDataPath });
    const engine: any = createAuthorizationEngine({ store: authorizationStore });
    const provider: any = createSecurityPermissionsProvider({ authorizationEngine: engine });
    const operation: any = governedOperation();
    const response: any = createResponse();
    const proofSubstrate: any = createProofSubstrate();
    const handler: any = vi.fn(({ response: innerResponse }: Record<string, any>) : any => {
      innerResponse.writeHead(200, { "Content-Type": "application/json" });
      innerResponse.end(JSON.stringify({ governed: "ok" }));
    });
    const authorizeOperation: any = vi.fn(async (payload: Record<string, any>) : Promise<any> => {
      const result: any = await provider.authorizeOperation({
        ...payload,
        authSession: AUTHORIZED_SESSION,
        context: { transport: "http" }
      });
      return result;
    });
    const revalidateAuthorization: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      authorizationDecision: { allowed: true, decisionId: "revalidation-decision" }
    }));

    const before: any = getProofLifecycleRefactorInstrumentation();
    const outcome: any = await dispatchOperation({
      operation,
      controllers: governedControllers(handler),
      request: { headers: {} },
      response,
      input: { body: { token: "governed-request-secret" } },
      url: new URL("http://127.0.0.1/api/unit/governed/evidence"),
      method: "POST",
      transport: "http",
      authorizeOperation,
      revalidateAuthorization,
      operationAuditStore: auditStore,
      operationProofSubstrate: proofSubstrate,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    try {
      expect(outcome.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);

      const decisions: any = await authorizationStore.listDecisions({ operationId: "unit.governed.evidence", limit: 20 });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ effect: "allow", reasonCode: "allowed" });

      expect(proofSubstrate.beginLifecycle).toHaveBeenCalledTimes(1);
      expect(proofSubstrate.finishLifecycle).toHaveBeenCalledTimes(1);
      expect(proofSubstrate.recordReceipt).not.toHaveBeenCalled();
      const after: any = getProofLifecycleRefactorInstrumentation();
      expect(after.proofLifecycleStartCount - before.proofLifecycleStartCount).toBe(1);
      expect(after.proofSettlementCount - before.proofSettlementCount).toBe(1);

      const auditRecords: any = await auditStore.list({ operationId: "unit.governed.evidence", limit: 10 });
      expect(auditRecords).toHaveLength(1);
      expect(auditRecords[0]).toMatchObject({
        decisionId: decisions[0].decisionId,
        proofId: "prepared-proof",
        status: "ok",
        error: ""
      });
      expect(auditRecords[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(auditRecords[0].redactedInput).toEqual({ body: { token: "<redacted>" } });
      expect(JSON.stringify(auditRecords)).not.toContain("governed-request-secret");
    } finally {
      await authorizationStore.close();
      await auditStore.close();
    }
  });

  it("binds a denied admission to its canonical decision and reference-only denied row", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-denied-");
    const authorizationStore: any = createAuthorizationStore({ userDataPath });
    const auditStore: any = createOperationAuditStore({ userDataPath });
    const engine: any = createAuthorizationEngine({ store: authorizationStore });
    const provider: any = createSecurityPermissionsProvider({ authorizationEngine: engine });
    const operation: any = governedOperation({ requiredScopes: ["runtime:write"] });
    const response: any = createResponse();
    const handler: any = vi.fn(({ response: innerResponse }: Record<string, any>) : any => {
      innerResponse.writeHead(200, {});
      innerResponse.end();
    });
    const authorizeOperation: any = vi.fn(async (payload: Record<string, any>) : Promise<any> => {
      const result: any = await provider.authorizeOperation({
        ...payload,
        authSession: {
          sessionId: "governed-evidence-denied-session",
          user: {
            type: "console-user",
            userId: "denied-subject",
            subjectId: "denied-subject",
            username: "denied-user",
            roleId: "member",
            tenantId: "denied-tenant",
            scopes: []
          }
        },
        context: { transport: "http" }
      });
      return result;
    });

    const outcome: any = await dispatchOperation({
      operation,
      controllers: governedControllers(handler),
      request: { headers: {} },
      response,
      input: { body: { token: "denied-request-secret" } },
      url: new URL("http://127.0.0.1/api/unit/governed/evidence"),
      method: "POST",
      transport: "http",
      authorizeOperation,
      revalidateAuthorization: vi.fn(async () : Promise<any> => ({ ok: false, status: 403 })),
      operationAuditStore: auditStore,
      operationProofSubstrate: createProofSubstrate(),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    try {
      expect(outcome).toMatchObject({ ok: false, handled: true, statusCode: 403 });
      expect(handler).not.toHaveBeenCalled();

      const decisions: any = await authorizationStore.listDecisions({ operationId: "unit.governed.evidence", limit: 20 });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ effect: "deny" });
      expect(decisions[0].decision.allowed).toBe(false);

      const deniedRequests: any = await authorizationStore.listDeniedRequests({
        subjectId: "denied-subject",
        operationId: "unit.governed.evidence",
        limit: 20
      });
      expect(deniedRequests).toHaveLength(1);
      expect(deniedRequests[0].deniedRequest).toMatchObject({
        decisionId: decisions[0].decisionId,
        effect: "deny",
        allowed: false
      });
      expect(JSON.stringify(deniedRequests[0].deniedRequest)).toContain("<redacted>");
      const auditRecords: any = await auditStore.list({ operationId: "unit.governed.evidence", limit: 10 });
      expect(auditRecords).toHaveLength(1);
      expect(auditRecords[0]).toMatchObject({
        decisionId: decisions[0].decisionId,
        status: "denied",
        error: ""
      });
      expect(auditRecords[0].redactedInput).toEqual({ body: { token: "<redacted>" } });
      expect(JSON.stringify(auditRecords)).not.toContain("denied-request-secret");
    } finally {
      await authorizationStore.close();
      await auditStore.close();
    }
  });

  it("denies before any protected effect when mandatory proof preparation fails", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-prepare-");
    const auditStore: any = createOperationAuditStore({ userDataPath });
    const response: any = createResponse();
    const handler: any = vi.fn(({ response: innerResponse }: Record<string, any>) : any => {
      innerResponse.writeHead(200, {});
      innerResponse.end();
    });
    const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      authorizationDecision: { allowed: true, decisionId: "admission-decision" },
      session: AUTHORIZED_SESSION
    }));
    const revalidateAuthorization: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      authorizationDecision: { allowed: true, decisionId: "revalidation-decision" }
    }));
    const beginLifecycle: any = vi.fn(async () : Promise<any> => {
      throw Object.assign(new Error("proof storage exhausted"), { code: "operation_proof_storage_exhausted" });
    });
    const finishLifecycle: any = vi.fn(async () : Promise<any> => ({ ledgerEventId: "prepared-proof" }));
    const recordReceipt: any = vi.fn(async () : Promise<any> => ({ ledgerEventId: "receipt-proof" }));

    const outcome: any = await dispatchOperation({
      operation: governedOperation(),
      controllers: governedControllers(handler),
      request: { headers: {} },
      response,
      input: {},
      url: new URL("http://127.0.0.1/api/unit/governed/evidence"),
      method: "POST",
      transport: "http",
      authorizeOperation,
      revalidateAuthorization,
      operationAuditStore: auditStore,
      operationProofSubstrate: { beginLifecycle, finishLifecycle, recordReceipt },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    try {
      expect(outcome).toMatchObject({ ok: false, handled: true, statusCode: 503 });
      expect(handler).not.toHaveBeenCalled();
      expect(beginLifecycle).toHaveBeenCalledTimes(1);
      expect(finishLifecycle).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(503);
    } finally {
      await auditStore.close();
    }
  });

  it("settles a post-effect settlement failure as in doubt without blind retry", async () : any => {
    const userDataPath: any = await temporaryUserDataPath("meshrix-governed-evidence-indoubt-");
    const auditStore: any = createOperationAuditStore({ userDataPath });
    const response: any = createResponse();
    const handler: any = vi.fn(({ response: innerResponse }: Record<string, any>) : any => {
      innerResponse.writeHead(200, {});
      innerResponse.end();
    });
    const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      authorizationDecision: { allowed: true, decisionId: "admission-decision" },
      session: AUTHORIZED_SESSION
    }));
    const revalidateAuthorization: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      authorizationDecision: { allowed: true, decisionId: "revalidation-decision" }
    }));
    const finishLifecycle: any = vi.fn(async () : Promise<any> => {
      throw new Error("ledger settlement failed after effect");
    });

    await expect(dispatchOperation({
      operation: governedOperation(),
      controllers: governedControllers(handler),
      request: { headers: {} },
      response,
      input: {},
      url: new URL("http://127.0.0.1/api/unit/governed/evidence"),
      method: "POST",
      transport: "http",
      authorizeOperation,
      revalidateAuthorization,
      operationAuditStore: auditStore,
      operationProofSubstrate: createProofSubstrate({ finishLifecycle }),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      statusCode: 503,
      retryable: false
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(finishLifecycle).toHaveBeenCalledTimes(2);
    expect(finishLifecycle.mock.calls[1][0]).toMatchObject({ status: "in_doubt" });
    const auditRecords: any = await auditStore.list({ operationId: "unit.governed.evidence", limit: 10 });
    expect(auditRecords).toHaveLength(2);
    expect(auditRecords.map((record?: any) : any => record.status).sort()).toEqual(["in_doubt", "ok"]);
    expect(auditRecords.every((record?: any) : any => record.error === "")).toBe(true);
    await auditStore.close();
  });
});
