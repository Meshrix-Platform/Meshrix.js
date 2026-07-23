import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dispatchOperation } from "#lico/server-runtime/composition/dispatch-operation";
import { MemoryLockManager } from "#lico/foundation/concurrency/lock-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const operationNarrowDefinitionPath = path.resolve(
  __dirname,
  "../../../packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json"
);

function getOperationNarrowDefinition() {
  return JSON.parse(fs.readFileSync(operationNarrowDefinitionPath, "utf8"));
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      const lowerName = String(name || "").toLowerCase();
      const entry = Object.entries(this.headers).find(([headerName]) => headerName.toLowerCase() === lowerName);
      return entry?.[1];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    }
  };
}

function createMockOperationProofSubstrate() {
  let sequence = 0;
  return {
    beginLifecycle: vi.fn(async () => ({
      ledgerEventId: `test-proof-${sequence += 1}`
    })),
    finishLifecycle: vi.fn(async ({ entry, ...patch }) => ({
      ...entry,
      ...patch
    }))
  };
}

const publishOperation = {
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
const operationLockManager = new MemoryLockManager();

afterAll(() => {
  operationLockManager.destroy();
});

describe("Operation Narrow Path State Machine Integration", () => {
  it("should load definitions correctly and pass verifier validations", () => {
    const def = getOperationNarrowDefinition();
    expect(def.machineId).toBe("operation.narrow");
    expect(def.initialState).toBe("received");
    expect(def.states).toHaveLength(10);
  });

  it("should transition through the legal path received -> normalized -> policy_checked -> proof_started -> executing -> audit_recorded -> completed", async () => {
    const eventsRecorded = [];
    const response = createResponse();

    const mockControllers = {
      system: {
        handleWorkspaceContributionPublish: vi.fn(async ({ response: res }) => {
          eventsRecorded.push({ type: "side-effect" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        })
      }
    };

    const mockAuditStore = {
      append: vi.fn((entry) => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_1" };
      })
    };

    const request = {
      onNarrowTransition: (event, toStatus) => {
        eventsRecorded.push({ type: "transition", event, toStatus });
      },
      onSideEffectStart: () => {
        eventsRecorded.push({ type: "side-effect-pre" });
      }
    };

    const result = await dispatchOperation({
      operation: publishOperation,
      controllers: mockControllers,
      request,
      response,
      input: { contributionId: "c1", confirm: true },
      requestBody: Buffer.from(JSON.stringify({ confirm: true })),
      url: new URL("http://127.0.0.1/api/workspace/contributions/c1/publish"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      authorizeOperation: async () => ({
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

    const transitions = eventsRecorded.filter((e) => e.type === "transition").map((e) => e.toStatus);
    expect(transitions).toEqual([
      "normalized",
      "policy_checked",
      "proof_started",
      "executing",
      "audit_recorded",
      "completed"
    ]);

    // Check PO-OP-001 & PO-OP-002: Side effects cannot start before policy_checked or proof_started.
    const sideEffectPreIndex = eventsRecorded.findIndex((e) => e.type === "side-effect-pre");
    const sideEffectIndex = eventsRecorded.findIndex((e) => e.type === "side-effect");
    const policyCheckedIndex = eventsRecorded.findIndex((e) => e.type === "transition" && e.toStatus === "policy_checked");
    const proofStartedIndex = eventsRecorded.findIndex((e) => e.type === "transition" && e.toStatus === "proof_started");

    expect(policyCheckedIndex).toBeLessThan(sideEffectPreIndex);
    expect(proofStartedIndex).toBeLessThan(sideEffectPreIndex);
    expect(sideEffectPreIndex).toBeLessThan(sideEffectIndex);

    // Check PO-OP-004: Completed state is transitioned only after the complete audit is recorded.
    const completedIndex = eventsRecorded.findIndex((e) => e.type === "transition" && e.toStatus === "completed");
    const completeAuditIndex = eventsRecorded.findIndex((e) => e.type === "audit" && e.status === "ok");
    expect(completeAuditIndex).toBeLessThan(completedIndex);
  });

  it("should record policy_denied state and write denied audit when policy evaluation is denied", async () => {
    const eventsRecorded = [];
    const response = createResponse();

    const mockControllers = {
      system: {
        handleWorkspaceContributionPublish: vi.fn()
      }
    };

    const mockAuditStore = {
      append: vi.fn((entry) => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_denied" };
      })
    };

    const request = {
      onNarrowTransition: (event, toStatus) => {
        eventsRecorded.push({ type: "transition", event, toStatus });
      }
    };

    const result = await dispatchOperation({
      operation: publishOperation,
      controllers: mockControllers,
      request,
      response,
      // Deny: missing confirm=true
      input: { contributionId: "c2" },
      requestBody: Buffer.from(JSON.stringify({})),
      url: new URL("http://127.0.0.1/api/workspace/contributions/c2/publish"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      authorizeOperation: async () => ({
        ok: true,
        session: { user: { scopes: ["workspace:maintain"] } }
      }),
      operationAuditStore: mockAuditStore
    });

    expect(result.ok).toBe(false);
    expect(response.statusCode).toBe(428); // requires confirmation

    // Verify transitions: received -> normalized -> policy_denied
    const transitions = eventsRecorded.filter((e) => e.type === "transition").map((e) => e.toStatus);
    expect(transitions).toEqual(["normalized", "policy_denied"]);

    // Verify PO-OP-003: Denied audit is written.
    const deniedAudits = eventsRecorded.filter((e) => e.type === "audit" && e.status === "denied");
    expect(deniedAudits).toHaveLength(1);

    // Side effect should never execute.
    expect(mockControllers.system.handleWorkspaceContributionPublish).not.toHaveBeenCalled();
  });

  it("should transition to failed state and write failed audit when handler execution fails", async () => {
    const eventsRecorded = [];
    const response = createResponse();

    const mockControllers = {
      system: {
        handleWorkspaceContributionPublish: vi.fn(async () => {
          throw new Error("Execution blew up");
        })
      }
    };

    const mockAuditStore = {
      append: vi.fn((entry) => {
        eventsRecorded.push({ type: "audit", status: entry.status });
        return { auditId: "mock_audit_failed" };
      })
    };

    const request = {
      onNarrowTransition: (event, toStatus) => {
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
      authorizeOperation: async () => ({
        ok: true,
        session: { user: { scopes: ["workspace:maintain"] } }
      }),
      operationAuditStore: mockAuditStore,
      lockManager: operationLockManager,
      operationProofSubstrate: createMockOperationProofSubstrate()
    })).rejects.toThrow("Execution blew up");

    // Verify transitions: received -> normalized -> policy_checked -> proof_started -> executing -> failed
    const transitions = eventsRecorded.filter((e) => e.type === "transition").map((e) => e.toStatus);
    expect(transitions).toEqual([
      "normalized",
      "policy_checked",
      "proof_started",
      "executing",
      "failed"
    ]);

    // Verify PO-OP-005: Failed audit is written.
    const failedAudits = eventsRecorded.filter((e) => e.type === "audit" && e.status === "failed");
    expect(failedAudits).toHaveLength(1);
  });
});
