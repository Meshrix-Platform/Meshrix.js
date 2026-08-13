import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_PROOF_PROFILES,
  decorateServerApiOperations
} from "#meshrix/contracts/operations/operation-decorators";
import {
  dispatchOperation
} from "#meshrix/server-runtime/composition/dispatch-operation";
import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import { MemoryLockManager } from "#meshrix/foundation/concurrency/lock-manager";
import {
  OPERATION_PROOF_SUBSTRATE_MODES,
  OPERATION_PROOF_SUBSTRATE_PROVIDER,
  createOperationProofSubstrate
} from "#meshrix/foundation/proof/proof-substrate/index";
import {
  assertEvidencePolicyReadinessFromEnv,
  evaluateEvidencePolicyReadiness
} from "./lib/operation-proof-evidence-policy.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function* walkFiles(directory?: any) : AsyncGenerator<any, any, any> {
  const entries: any = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "build", "node_modules", "tmp"].includes(entry.name)) {
      continue;
    }
    const filePath: any = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(filePath);
      continue;
    }
    if (entry.isFile() && filePath.endsWith(".ts")) {
      yield filePath;
    }
  }
}

function createMockResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    ended: false,
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    end(body: any = "") : any {
      this.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
      this.ended = true;
    }
  };
}

function createMockProofSubstrate() : any {
  const calls: any[] = [];
  let sequence: any = 0;
  return {
    calls,
    async beginLifecycle(input: Record<string, any> = {}) : Promise<any> {
      sequence += 1;
      const entry: Record<string, any> = {
        ledgerEventId: `proof_entry_${sequence}`,
        operationId: input.operationId,
        status: "started",
        input
      };
      calls.push({ kind: "begin", input, entry });
      return entry;
    },
    async finishLifecycle(input: Record<string, any> = {}) : Promise<any> {
      const entry: Record<string, any> = {
        ...(input.entry || {}),
        ledgerEventId: input.ledgerEventId || input.entry?.ledgerEventId,
        status: input.status,
        outcomeKind: input.outcomeKind || input.status,
        auditId: input.auditId || ""
      };
      calls.push({ kind: "finish", input, entry });
      return entry;
    },
    async recordReceipt(input: Record<string, any> = {}) : Promise<any> {
      sequence += 1;
      const entry: Record<string, any> = {
        ledgerEventId: `proof_receipt_${sequence}`,
        operationId: input.operationId,
        status: input.status,
        proof: { profile: input.profile || "receipt" }
      };
      calls.push({ kind: "receipt", input, entry });
      return entry;
    }
  };
}

function createAuditStore(records?: any) : any {
  return {
    append(entry: Record<string, any> = {}) : any {
      const auditRecord: Record<string, any> = {
        auditId: `audit_${records.length + 1}`,
        ...entry
      };
      records.push(auditRecord);
      return auditRecord;
    }
  };
}

function operationForDispatcherVerification() : any {
  return decorateServerApiOperations([
    {
      id: "verify.operation_proof_substrate.dispatch",
      feature: "verification",
      label: "Operation proof substrate dispatcher verification",
      target: { controller: "verify", method: "handle" },
      http: { method: "POST", path: "/api/verify/operation-proof-substrate" },
      rpc: { method: "verify.operation_proof_substrate.dispatch", body: "params" },
      requiredScopes: ["runtime:admin"],
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          idempotencyKey: { type: "string" }
        }
      },
      safety: { risk: "safe_write" }
    }
  ])[0];
}

async function assertProviderContract() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-proof-substrate-"));
  try {
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir });
    assert.equal(proofSubstrate.provider, OPERATION_PROOF_SUBSTRATE_PROVIDER);
    assert.equal(proofSubstrate.mode, OPERATION_PROOF_SUBSTRATE_MODES.PACTIUM);
    assert.equal(Boolean(proofSubstrate.pactiumRuntime?.core), true);

    const entry: any = await proofSubstrate.beginLifecycle({
      operationId: "verify.operation_proof_substrate.provider",
      workspaceId: "verify-workspace",
      idempotencyKey: "verify-provider-1",
      input: { workspaceId: "verify-workspace" },
      subject: { type: "system" },
      policyDecision: { decision: "allow", reasonCode: "verification" }
    });
    assert.equal(entry.status, "started");
    assert.ok(entry.ledgerEventId);
    assert.ok(entry.pactium?.intentId);

    const completed: any = await proofSubstrate.finishLifecycle({
      entry,
      status: "succeeded",
      result: { ok: true },
      auditId: "audit_verify_provider"
    });
    assert.equal(completed.status, "succeeded");
    assert.ok(completed.pactium?.outcomeEnvelopeId);

    await assert.rejects(
      () : any => proofSubstrate.exportProofBundle({
        ledgerEventId: completed.ledgerEventId,
        actor: { type: "console-user", scopes: ["console:read"] }
      }),
      /Proof Bundle Export requires/
    );

    const bundle: any = await proofSubstrate.exportProofBundle({
      ledgerEventId: completed.ledgerEventId,
      actor: { type: "system" }
    });
    assert.equal(String(bundle.bundleType || "").includes("proof-bundle"), true);
    const verification: any = await proofSubstrate.verifyReceipt({ bundle });
    assert.equal(verification.ok, true);

    // Acceptance evidence anchoring
    const anchor: any = await proofSubstrate.recordAcceptanceEvidence({
      reportDigests: [
        { path: "build/reports/example.json", schemaVersion: "v0.0.1:acceptance:platform-report-2", contentHash: "sha256:deadbeef" }
      ],
      releaseId: "verify-release",
      actor: { type: "system" }
    });
    assert.ok(anchor.ledgerEventId, "acceptance evidence anchor must produce a ledger event id");
    assert.equal(anchor.workspaceId, "release:verify-release");

    // Rejects missing releaseId
    await assert.rejects(
      () : any => proofSubstrate.recordAcceptanceEvidence({ reportDigests: [{ path: "x", schemaVersion: "v1", contentHash: "sha256:aa" }] }),
      /releaseId is required/
    );

    // Rejects empty reportDigests
    await assert.rejects(
      () : any => proofSubstrate.recordAcceptanceEvidence({ reportDigests: [], releaseId: "r1" }),
      /non-empty array/
    );

    const projection: any = proofSubstrate.getWorkspaceProjection("verify-workspace");
    assert.equal(typeof projection, "object");
    const recoveryPlan: any = proofSubstrate.planRecovery({ workspaceId: "verify-workspace" });
    assert.equal(typeof recoveryPlan, "object");
    const capabilities: any = proofSubstrate.listCapabilities().capabilities.map((capability?: any) : any => capability.id);
    assert.ok(capabilities.includes("operation-proof-lifecycle"));
    assert.ok(capabilities.includes("receipt-verification-export"));

    assert.throws(
      () : any => createOperationProofSubstrate({ dataDir, mode: "disabled" }),
      /only supports Pactium-backed mode/
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() : any => {});
  }
}

async function assertDispatcherLifecycle() : Promise<any> {
  const operation: any = operationForDispatcherVerification();
  const lockManager: any = new MemoryLockManager();
  const controllers: Record<string, any> = {
    verify: {
      async handle({ response }: Record<string, any>) : Promise<any> {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
      }
    }
  };
  const url: any = new URL("http://127.0.0.1/api/verify/operation-proof-substrate");

  {
    const proof: any = createMockProofSubstrate();
    const auditRecords: any[] = [];
    const response: any = createMockResponse();
    const result: any = await dispatchOperation({
      operation,
      controllers,
      request: {},
      response,
      requestBody: Buffer.from(JSON.stringify({
        workspaceId: "verify-workspace",
        idempotencyKey: "success-1"
      })),
      url,
      transport: "http",
      method: "POST",
      authorizeOperation: async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "verify-user", scopes: ["runtime:admin"] } }
      }),
      operationAuditStore: createAuditStore(auditRecords),
      operationProofSubstrate: proof,
      lockManager
    });
    assert.equal(result.ok, true);
    assert.deepEqual(proof.calls.map((call?: any) : any => call.kind), ["begin", "finish"]);
    assert.equal(proof.calls[0].input.operationId, operation.id);
    assert.equal(proof.calls[1].input.status, "succeeded");
    assert.equal(auditRecords.at(-1)?.status, "ok");
  }

  {
    const proof: any = createMockProofSubstrate();
    const auditRecords: any[] = [];
    const response: any = createMockResponse();
    const result: any = await dispatchOperation({
      operation,
      controllers,
      request: {},
      response,
      requestBody: Buffer.from(JSON.stringify({
        workspaceId: "verify-workspace",
        idempotencyKey: "denied-1"
      })),
      url,
      transport: "http",
      method: "POST",
      authorizeOperation: async () : Promise<any> => ({
        ok: false,
        status: 403,
        error: "denied by verifier",
        authorizationDecision: { reasonCode: "verification_denied" }
      }),
      operationAuditStore: createAuditStore(auditRecords),
      operationProofSubstrate: proof,
      lockManager
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 403);
    assert.deepEqual(proof.calls.map((call?: any) : any => call.kind), ["receipt"]);
    assert.equal(proof.calls[0].input.status, "denied");
    assert.equal(auditRecords.at(-1)?.status, "denied");
  }

  {
    const proof: any = createMockProofSubstrate();
    const auditRecords: any[] = [];
    const response: any = createMockResponse();
    const result: any = await dispatchOperation({
      operation,
      controllers,
      request: {},
      response,
      requestBody: Buffer.from(JSON.stringify({ idempotencyKey: "schema-invalid-1" })),
      url,
      transport: "http",
      method: "POST",
      authorizeOperation: async () : Promise<any> => ({ ok: true }),
      operationAuditStore: createAuditStore(auditRecords),
      operationProofSubstrate: proof,
      lockManager
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(proof.calls.map((call?: any) : any => call.kind), ["receipt"]);
    assert.equal(proof.calls[0].input.status, "denied");
    assert.equal(auditRecords.at(-1)?.status, "denied");
  }
  lockManager.destroy();
}

function assertOperationProofProfiles() : any {
  const invalid: any[] = [];
  const excludedWithoutReason: any[] = [];
  const missingProofAspect: any[] = [];
  for (const operation of SERVER_API_OPERATIONS) {
    if (!operation.proof || typeof operation.proof !== "object") {
      invalid.push(`${operation.id}:missing`);
      continue;
    }
    if (!(Object.values(OPERATION_PROOF_PROFILES) as any[]).includes(operation.proof.profile)) {
      invalid.push(`${operation.id}:${operation.proof.profile || "empty"}`);
    }
    if (
      operation.proof.profile === OPERATION_PROOF_PROFILES.EXCLUDED &&
      !String(operation.proof.exclusionReason || "").trim()
    ) {
      excludedWithoutReason.push(operation.id);
    }
    if (!Array.isArray(operation.aspects) || !operation.aspects.includes("operation-proof")) {
      missingProofAspect.push(operation.id);
    }
  }
  assert.deepEqual(invalid, [], "all operations must declare a finite proof profile");
  assert.deepEqual(excludedWithoutReason, [], "proof exclusions must include an explicit reason");
  assert.deepEqual(missingProofAspect, [], "all operations must carry the operation-proof aspect");
}

async function assertPactiumImportBoundary() : Promise<any> {
  const allowed: any = new Set<any>([
    "packages/foundation/src/checkpoint/tree/checkpoint-tree-projection.ts",
    "packages/foundation/src/checkpoint/tree/data-structure-substrate.ts",
    "packages/foundation/src/checkpoint/tree/merkle-state-substrate.ts",
    "packages/foundation/src/checkpoint/tree/pactium-runtime.ts",
    "packages/foundation/src/proof/proof-substrate/index.ts",
    "packages/foundation/src/proof/proof-substrate/transparency-ledger.ts"
  ]);
  const offenders: any[] = [];
  const importPattern: any = /from\s+["']pactium["']|import\(\s*["']pactium["']\s*\)|require\(\s*["']pactium["']\s*\)/;
  for await (const filePath of walkFiles(path.join(repoRoot, "packages"))) {
    const source: any = await fs.readFile(filePath, "utf8");
    if (!importPattern.test(source)) {
      continue;
    }
    const relativePath: any = path.relative(repoRoot, filePath).replace(/\\/g, "/");
    if (!allowed.has(relativePath)) {
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(offenders, [], "Pactium imports must stay behind data/proof substrate facades");
}

function assertEvidencePolicyReadiness() : any {
  // Verifier-level fixtures: production without signer must fail; consistent pairs pass.
  assert.equal(
    evaluateEvidencePolicyReadiness({ evidencePolicy: "production", signerSecret: "" }).ok,
    false,
    "production policy without signer must fail readiness"
  );
  assert.equal(
    evaluateEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: "fixture-signer-not-a-real-secret"
    }).ok,
    true,
    "production policy with signer must pass readiness"
  );
  assert.equal(
    evaluateEvidencePolicyReadiness({ evidencePolicy: "development", signerSecret: "" }).ok,
    true,
    "development policy without signer must pass readiness"
  );
  try {
    assertEvidencePolicyReadinessFromEnv();
  } catch (error: any) {
    assert.fail(String(error?.message || error));
  }
}

async function assertPermissionAuditAnchoring() : Promise<any> {
  const dataDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-op-audit-anchor-"));
  try {
    const { createOperationPermissionStore } = await import(
      "#meshrix/capabilities/operation-permission-core/store"
    );
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(dataDir, "proof") });
    const store: any = createOperationPermissionStore({
      userDataPath: path.join(dataDir, "op"),
      proofSubstrate
    });
    try {
      const decision: any = await store.appendPolicyDecisionAnchored({
        toolExecutionId: "tool_exec_anchor_1",
        traceId: "trace-anchor-1",
        toolId: "meshrix.operation.proof-substrate",
        grantId: "grant_anchor",
        effect: "allow",
        reasonCode: "verification_allow",
        missingScopes: [],
        missingToolsets: [],
        evaluatedLayers: ["verification"]
      });
      assert.ok(decision.ledgerEventId, "policy decision must store ledgerEventId");

      const execution: any = await store.appendExecutionAnchored({
        toolExecutionId: "tool_exec_anchor_1",
        traceId: "trace-anchor-1",
        toolId: "meshrix.operation.proof-substrate",
        toolVersion: "v0.0.1:operation:proof-substrate-2",
        toolsetIds: ["verify"],
        subjectType: "grant",
        subjectId: "grant_anchor",
        grantId: "grant_anchor",
        operationId: "meshrix.operation.proof-substrate",
        risk: "safe_read",
        decision: "allow",
        input: {
          secret: "must-not-reach-ledger",
          token: "must-not-reach-ledger",
          workspaceId: "verify-workspace"
        },
        resultSummary: { ok: true },
        status: "ok",
        policyDecisionId: decision.decisionId,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
      assert.ok(execution.ledgerEventId, "tool execution must store ledgerEventId");
      assert.ok(execution.inputHash, "tool execution must store redacted input hash");

      const audit: any = store.getAudit("tool_exec_anchor_1");
      assert.equal(audit.ledgerEventId, execution.ledgerEventId);
      assert.equal(audit.inputHash, execution.inputHash);
      assert.notEqual(JSON.stringify(audit.redactedInput || {}).includes("must-not-reach-ledger"), true);

      const inclusion: any = await store.provePermissionAuditInclusion(
        execution.ledgerEventId,
        "grant_anchor"
      );
      assert.equal(inclusion.ok, true, "permission audit inclusion against ledger head must pass");

      // Redaction boundary: ledger input must carry hash only, never raw secret fields.
      const entries: any = await proofSubstrate.listReceipts({ limit: 20 });
      for (const entry of entries) {
        const serialized: any = JSON.stringify(entry || {});
        assert.equal(serialized.includes("must-not-reach-ledger"), false);
      }
    } finally {
      store.close();
      await proofSubstrate.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() : any => {});
  }
}

assertEvidencePolicyReadiness();
await assertProviderContract();
await assertPermissionAuditAnchoring();
await assertDispatcherLifecycle();
assertOperationProofProfiles();
await assertPactiumImportBoundary();

console.log("operation proof substrate verification passed");
