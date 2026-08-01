import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dispatchOperation } from "#meshrix/server-runtime/composition/dispatch-operation";
import { MemoryLockManager } from "#meshrix/foundation/concurrency/lock-manager";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const operationNarrowDefinitionPath: any = path.resolve(
  __dirname,
  "../../../packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json"
);

function getOperationNarrowDefinition() : any {
  return JSON.parse(fs.readFileSync(operationNarrowDefinitionPath, "utf8"));
}

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
    getHeader(name?: any) : any {
      const lowerName: any = String(name || "").toLowerCase();
      const entry: any = (Object.entries(this.headers) as [string, any][]).find(([headerName]: any[]) : any => headerName.toLowerCase() === lowerName);
      return entry?.[1];
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    },
    json() : any {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    }
  };
}

function createMockOperationProofSubstrate() : any {
  let sequence: any = 0;
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => ({
      ledgerEventId: `test-proof-${sequence += 1}`
    })),
    finishLifecycle: vi.fn(async ({ entry, ...patch }: Record<string, any>) : Promise<any> => ({
      ...entry,
      ...patch
    }))
  };
}

const publishOperation: Record<string, any> = {
  id: "workspace.contribution.publish",
  feature: "agent_workspace",
  label: "发布 workspace 贡献资产",
  target: { controller: "system", method: "handleWorkspaceContributionPublish" },
  http: { method: "POST", path: "/api/workspace/contributions/:contributionId/publish" },
  params: [{ name: "contributionId", aliases: ["contribution-id", "id"], required: true }],
  scopes: ["workspace:maintain"],
  safety: {
    risk: "repair_write",
    requiresConfirmation: true,
    approvalScope: "workspace:maintain"
  },
  inputSchema: { type: "object", properties: {} },
  log: { recordInput: true, redaction: "default" },
  audit: { enabled: true, recordInput: true }
};
const operationLockManager: any = new MemoryLockManager();

afterAll(() : any => {
  operationLockManager.destroy();
});

describe("Operation Narrow Path State Machine Integration", () : any => {
  it("should load definitions correctly and pass verifier validations", () : any => {
    const def: any = getOperationNarrowDefinition();
    expect(def.machineId).toBe("operation.narrow");
    expect(def.initialState).toBe("received");
    expect(def.states).toHaveLength(10);
  });

  it("should transition through the legal path received -> normalized -> policy_checked -> proof_started -> executing -> audit_recorded -> completed", async () : Promise<any> => {
    const eventsRecorded: any[] = [];
    const response: any = createResponse();

    const mockControllers: Record<string, any> = {
      system: {
        handleWorkspaceContributionPublish: vi.fn(async ({ response: res }: Record<string, any>) : Promise<any> => {
          eventsRecorded.push({ type: "side-effect" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        })
      }
    };

    const mockAuditStore: Record<string, any> = {
      append: vi.fn((entry?: any) : any => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_1" };
      })
    };

    const request: Record<string, any> = {
      onNarrowTransition: (event?: any, toStatus?: any) : any => {
        eventsRecorded.push({ type: "transition", event, toStatus });
      },
      onSideEffectStart: () : any => {
        eventsRecorded.push({ type: "side-effect-pre" });
      }
    };

    const result: any = await dispatchOperation({
      operation: publishOperation,
      controllers: mockControllers,
      request,
      response,
      input: { contributionId: "c1", confirm: true },
      requestBody: Buffer.from(JSON.stringify({ confirm: true })),
      url: new URL("http://127.0.0.1/api/workspace/contributions/c1/publish"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      authorizeOperation: async () : Promise<any> => ({
        ok: true,
        session: { user: { scopes: ["workspace:maintain"] } }
      }),
      operationAuditStore: mockAuditStore,
      lockManager: operationLockManager,
      operationProofSubstrate: createMockOperationProofSubstrate()
    });

    expect(result.ok).toBe(true);
    expect(response.statusCode).toBe(200);

    // Verify ordering trace:
    // 1. received -> normalized (normalize)
    // 2. normalized -> policy_checked (policy_allow)
    // 3. policy_checked -> proof_started (proof_start) -- writes start audit log
    // 4. proof_started -> executing (execute_start)
    // 5. side effect executes
    // 6. executing -> audit_recorded (audit_record) -- writes complete audit log
    // 7. audit_recorded -> completed (complete)

    const transitions: any = eventsRecorded.filter((e?: any) : any => e.type === "transition").map((e?: any) : any => e.toStatus);
    expect(transitions).toEqual([
      "normalized",
      "policy_checked",
      "proof_started",
      "executing",
      "audit_recorded",
      "completed"
    ]);

    // Check PO-OP-001 & PO-OP-002: Side effects cannot start before policy_checked or proof_started.
    const sideEffectPreIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "side-effect-pre");
    const sideEffectIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "side-effect");
    const policyCheckedIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "transition" && e.toStatus === "policy_checked");
    const proofStartedIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "transition" && e.toStatus === "proof_started");

    expect(policyCheckedIndex).toBeLessThan(sideEffectPreIndex);
    expect(proofStartedIndex).toBeLessThan(sideEffectPreIndex);
    expect(sideEffectPreIndex).toBeLessThan(sideEffectIndex);

    // Check PO-OP-004: Completed state is transitioned only after the complete audit is recorded.
    const completedIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "transition" && e.toStatus === "completed");
    const completeAuditIndex: any = eventsRecorded.findIndex((e?: any) : any => e.type === "audit" && e.status === "ok");
    expect(completeAuditIndex).toBeLessThan(completedIndex);
  });

  it("should record policy_denied state and write denied audit when policy evaluation is denied", async () : Promise<any> => {
    const eventsRecorded: any[] = [];
    const response: any = createResponse();

    const mockControllers: Record<string, any> = {
      system: {
        handleWorkspaceContributionPublish: vi.fn()
      }
    };

    const mockAuditStore: Record<string, any> = {
      append: vi.fn((entry?: any) : any => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_denied" };
      })
    };

    const request: Record<string, any> = {
      onNarrowTransition: (event?: any, toStatus?: any) : any => {
        eventsRecorded.push({ type: "transition", event, toStatus });
      }
    };

    const result: any = await dispatchOperation({
      operation: publishOperation,
      controllers: mockControllers,
      request,
      response,
      // Deny: missing confirm=true
      input: { contributionId: "c2" },
      requestBody: Buffer.from(JSON.stringify({})),
      url: new URL("http://127.0.0.1/api/workspace/contributions/c2/publish"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      authorizeOperation: async () : Promise<any> => ({
        ok: true,
        session: { user: { scopes: ["workspace:maintain"] } }
      }),
      operationAuditStore: mockAuditStore
    });

    expect(result.ok).toBe(false);
    expect(response.statusCode).toBe(428); // requires confirmation

    // Verify transitions: received -> normalized -> policy_denied
    const transitions: any = eventsRecorded.filter((e?: any) : any => e.type === "transition").map((e?: any) : any => e.toStatus);
    expect(transitions).toEqual(["normalized", "policy_denied"]);

    // Verify PO-OP-003: Denied audit is written.
    const deniedAudits: any = eventsRecorded.filter((e?: any) : any => e.type === "audit" && e.status === "denied");
    expect(deniedAudits).toHaveLength(1);

    // Side effect should never execute.
    expect(mockControllers.system.handleWorkspaceContributionPublish).not.toHaveBeenCalled();
  });

  it("should transition to failed state and write failed audit when handler execution fails", async () : Promise<any> => {
    const eventsRecorded: any[] = [];
    const response: any = createResponse();

    const mockControllers: Record<string, any> = {
      system: {
        handleWorkspaceContributionPublish: vi.fn(async () : Promise<any> => {
          throw new Error("Execution blew up");
        })
      }
    };

    const mockAuditStore: Record<string, any> = {
      append: vi.fn((entry?: any) : any => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_failed" };
      })
    };

    const request: Record<string, any> = {
      onNarrowTransition: (event?: any, toStatus?: any) : any => {
        eventsRecorded.push({ type: "transition", event, toStatus });
      }
    };

    await expect(dispatchOperation({
      operation: publishOperation,
      controllers: mockControllers,
      request,
      response,
      input: { contributionId: "c3", confirm: true },
      requestBody: Buffer.from(JSON.stringify({ confirm: true })),
      url: new URL("http://127.0.0.1/api/workspace/contributions/c3/publish"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      authorizeOperation: async () : Promise<any> => ({
        ok: true,
        session: { user: { scopes: ["workspace:maintain"] } }
      }),
      operationAuditStore: mockAuditStore,
      lockManager: operationLockManager,
      operationProofSubstrate: createMockOperationProofSubstrate()
    })).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false
    });

    // Verify transitions: received -> normalized -> policy_checked -> proof_started -> executing -> failed
    const transitions: any = eventsRecorded.filter((e?: any) : any => e.type === "transition").map((e?: any) : any => e.toStatus);
    expect(transitions).toEqual([
      "normalized",
      "policy_checked",
      "proof_started",
      "executing",
      "failed"
    ]);

    // Verify PO-OP-005: Failed audit is written.
    const failedAudits: any = eventsRecorded.filter((e?: any) : any => e.type === "audit" && e.status === "in_doubt");
    expect(failedAudits).toHaveLength(1);
  });
});
