import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RISK_CONTROL_BOUNDARY_IDS,
  RISK_CONTROL_GATES,
  RISK_CONTROL_MODEL_VERSION,
  RISK_CONTROL_OBJECT_ORDER,
  RISK_CONTROL_POINTS,
  appendRiskControlGateRecord,
  assertRiskControlRegistryComplete,
  createRiskControlOperationEnvelope,
  createRiskControlProjection,
  describeRiskControlModel,
  listRiskControlBoundaries,
  listRiskControlEnvironments,
  listRiskControlObjects,
  riskControlControlsByGate,
  riskControlControlsByObject
} from "../../../packages/foundation/src/security/risk-control/index.ts";
import { createAuthorizationStore } from "../../../packages/foundation/src/security/authorization/authorization-store.ts";

const tempRoots: any[] = [];

async function tempDir(prefix?: any) : Promise<any> {
  const dir: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function withAuthorizationStore(testCase?: any) : Promise<any> {
  const userDataPath: any = await tempDir("meshrix-risk-control-store-extra-");
  const store: any = createAuthorizationStore({ userDataPath });
  try {
    return await testCase({ store, userDataPath });
  } finally {
    store.close();
  }
}

function deepPayload(depth?: any, label: any = "leaf") : any {
  if (depth <= 0) {
    return { label };
  }
  return {
    depth,
    child: deepPayload(depth - 1, label)
  };
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((dir?: any) : any => fs.rm(dir, { recursive: true, force: true })));
});

describe("risk control model behavior", () : any => {
  it("returns cloned model data, covers every object and gate, and builds a hash-chained envelope", () : any => {
    const boundaries: any = listRiskControlBoundaries();
    const environments: any = listRiskControlEnvironments();
    const objects: any = listRiskControlObjects();

    expect(boundaries).toHaveLength(3);
    expect(environments).toHaveLength(3);
    expect(objects).toHaveLength(5);

    boundaries[0].label = "mutated-boundary";
    environments[0].label = "mutated-environment";
    objects[0].label = "mutated-object";

    expect(listRiskControlBoundaries()[0].label).not.toBe("mutated-boundary");
    expect(listRiskControlEnvironments()[0].label).not.toBe("mutated-environment");
    expect(listRiskControlObjects()[0].label).not.toBe("mutated-object");

    const clientControls: any = riskControlControlsByObject({ boundaryId: RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS });
    expect(clientControls.map((entry?: any) : any => entry.objectId)).toEqual(RISK_CONTROL_OBJECT_ORDER);
    expect(clientControls.every((entry?: any) : any => entry.controls.length > 0)).toBe(true);
    expect(riskControlControlsByObject({ boundaryId: "missing-boundary" }).map((entry?: any) : any => entry.controls)).toEqual(
      RISK_CONTROL_OBJECT_ORDER.map(() : any => [])
    );

    const gates: any = new Set<any>(riskControlControlsByGate().map((entry?: any) : any => entry.gate));
    for (const gate of RISK_CONTROL_GATES) {
      expect(gates.has(gate)).toBe(true);
    }

    const projection: any = createRiskControlProjection();
    expect(projection.boundaries).toHaveLength(3);
    expect(projection.controlsByObject).toHaveLength(5);
    projection.objects[0].label = "changed";
    expect(listRiskControlObjects()[0].label).not.toBe("changed");

    const model: any = describeRiskControlModel();
    expect(model).toMatchObject({
      modelVersion: RISK_CONTROL_MODEL_VERSION,
      boundaryCount: 3,
      environmentCount: 3,
      objectCount: 5
    });
    expect(model.controlCount).toBeGreaterThanOrEqual(60);
    expect(() : any => assertRiskControlRegistryComplete()).not.toThrow();

    const firstControl: any = RISK_CONTROL_POINTS.find((control?: any) : any => control.controlId === "client.registration.admit");
    const secondControl: any = RISK_CONTROL_POINTS.find((control?: any) : any => control.controlId === "client.mcp-grant.authorize");
    const envelope: any = createRiskControlOperationEnvelope({
      operationId: "risk-control.unit",
      traceId: "trace-risk-control-unit",
      inputHash: "sha256:unit"
    });
    const first: any = appendRiskControlGateRecord(envelope, {
      control: firstControl,
      decision: "allow",
      reasonCode: "unit_first"
    });
    const second: any = appendRiskControlGateRecord(envelope, {
      control: secondControl,
      decision: "allow",
      reasonCode: "unit_second"
    });
    expect(envelope.gateRecords).toHaveLength(2);
    expect(first.previousRecordDigest).toBe(envelope.operationAnchorDigest);
    expect(second.previousRecordDigest).toBe(first.recordDigest);
    expect(second.recordDigest).toMatch(/^sha256:v0\.0\.1:strategy:risk-control-gate-record-1:/);
  });
});

describe("authorization store behavior", () : any => {
  it("normalizes writes, redacts denied payloads, and clamps list limits", async () : Promise<any> => {
    await withAuthorizationStore(async ({ store }: Record<string, any>) : Promise<any> => {
      const decisionPayload: Record<string, any> = {
        traceId: "trace-1",
        subject: {
          type: "user",
          subjectId: "subject-1"
        },
        operation: {
          id: "authorization.policy.evaluate"
        },
        tool: {
          id: "tool-1"
        },
        grant: {
          id: "grant-1"
        },
        tenant: {
          resourceTenantId: "tenant-a"
        },
        abac: {
          workspaceId: "workspace-a",
          dataClass: "confidential",
          requestedEgress: "https://egress.example.test"
        },
        resource: {
          tenantId: "tenant-b",
          workspaceId: "workspace-b",
          dataClass: "public"
        },
        action: "evaluate",
        effect: "deny",
        allowed: false,
        reasonCode: "policy_denied",
        missingScopes: ["scope:a"],
        missingToolsets: ["toolset:a"],
        requiredScopes: ["scope:required"],
        evaluatedLayers: [{ layer: "policy" }],
        decision: {
          token: "Bearer secret-token",
          apiKey: "secret-api-key",
          subjectCapabilities: ["cap-a", "cap-b"],
          subject: {
            capabilities: ["cap-x"]
          },
          nested: deepPayload(10)
        },
        createdAt: "2026-06-01T00:00:00.000Z"
      };

      const firstDecision: any = await store.appendDecision(decisionPayload);
      const secondDecision: any = await store.appendDecision({
        ...decisionPayload,
        decisionId: "decision-2",
        traceId: "trace-2",
        subject: {
          type: "user",
          subjectId: "subject-2"
        },
        operation: {
          id: "authorization.receipts.list"
        },
        effect: "allow",
        allowed: true,
        reasonCode: "allowed",
        decision: {
          ok: true
        },
        createdAt: "2026-06-02T00:00:00.000Z"
      });

      const allDecisions: any = await store.listDecisions({ limit: "500" });
      expect(allDecisions.map((entry?: any) : any => entry.decisionId)).toEqual([secondDecision.decisionId, firstDecision.decisionId]);

      const firstListed: any = await store.listDecisions({
        subjectId: "subject-1",
        traceId: "trace-1",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        operationId: "authorization.policy.evaluate",
        effect: "deny",
        limit: 0
      });
      expect(firstListed).toHaveLength(1);
      expect(firstListed[0]).toMatchObject({
        decisionId: firstDecision.decisionId,
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        dataClass: "confidential",
        requestedEgress: "https://egress.example.test",
        effect: "deny",
        reasonCode: "policy_denied",
        missingScopes: ["scope:a"],
        missingToolsets: ["toolset:a"],
        requiredScopes: ["scope:required"],
        evaluatedLayers: [{ layer: "policy" }]
      });
      expect(firstListed[0].decision.decision).toMatchObject({
        token: "<redacted>",
        apiKey: "<redacted>",
        subjectCapabilities: {
          redacted: true,
          count: 2
        },
        subject: {
          capabilities: {
            redacted: true,
            count: 1
          }
        }
      });
      expect(JSON.stringify(firstListed[0].decision.decision)).toContain("<redacted-depth>");

      const deniedRequests: any = await store.listDeniedRequests({
        subjectId: "subject-1",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        operationId: "authorization.policy.evaluate",
        reasonCode: "policy_denied",
        limit: -2
      });
      expect(deniedRequests).toHaveLength(1);
      expect(deniedRequests[0]).toMatchObject({
        decisionId: firstDecision.decisionId,
        subjectId: "subject-1",
        operationId: "authorization.policy.evaluate",
        toolId: "tool-1",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        reasonCode: "policy_denied"
      });
      expect(JSON.stringify(deniedRequests[0].deniedRequest)).toContain("<redacted>");

      const receipt: any = await store.appendReceipt({
        decisionId: firstDecision.decisionId,
        subject: {
          userId: "subject-1"
        },
        workspaceId: "workspace-a",
        accessMode: "read",
        receipt: {
          receiptId: "receipt-1",
          summary: "ok"
        },
        createdAt: "2026-06-03T00:00:00.000Z"
      });

      const loanRecord: any = await store.appendLoanRecord({
        receiptId: receipt.receiptId,
        decisionId: firstDecision.decisionId,
        subject: {
          id: "subject-1"
        },
        workspaceId: "workspace-a",
        accessMode: "loan",
        loanRecord: {
          loanRecordId: "loan-1",
          issuedAt: "2026-06-03T00:00:00.000Z"
        },
        createdAt: "2026-06-03T00:00:00.000Z"
      });

      const receipts: any = await store.listReceipts({ subjectId: "subject-1", limit: 0 });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        receiptId: receipt.receiptId,
        decisionId: firstDecision.decisionId,
        subjectId: "subject-1",
        workspaceId: "workspace-a",
        accessMode: "read",
        createdAt: "2026-06-03T00:00:00.000Z"
      });
      expect(receipts[0].receipt).toMatchObject({
        receiptId: receipt.receiptId,
        receipt: {
          receiptId: "receipt-1",
          summary: "ok"
        }
      });

      const loanRecords: any = await store.listLoanRecords({ subjectId: "subject-1", limit: 0 });
      expect(loanRecords).toHaveLength(1);
      expect(loanRecords[0]).toMatchObject({
        loanRecordId: loanRecord.loanRecordId,
        receiptId: receipt.receiptId,
        decisionId: firstDecision.decisionId,
        subjectId: "subject-1",
        workspaceId: "workspace-a",
        accessMode: "loan",
        createdAt: "2026-06-03T00:00:00.000Z"
      });
      expect(loanRecords[0].loanRecord).toMatchObject({
        loanRecordId: loanRecord.loanRecordId,
        loanRecord: {
          loanRecordId: "loan-1",
          issuedAt: "2026-06-03T00:00:00.000Z"
        }
      });

      await expect(store.appendDecision({
        ...decisionPayload,
        decisionId: firstDecision.decisionId,
        effect: "allow",
        allowed: true
      })).rejects.toThrow();
      await expect(store.appendReceipt({
        receiptId: receipt.receiptId,
        decisionId: secondDecision.decisionId
      })).rejects.toThrow();
      await expect(store.appendLoanRecord({
        loanRecordId: loanRecord.loanRecordId,
        decisionId: secondDecision.decisionId
      })).rejects.toThrow();

      expect((await store.listDecisions({ subjectId: "subject-1" }))[0]).toMatchObject({
        decisionId: firstDecision.decisionId,
        effect: "deny"
      });
      expect((await store.listReceipts({ subjectId: "subject-1" }))[0]).toMatchObject({
        receiptId: receipt.receiptId,
        decisionId: firstDecision.decisionId
      });
      expect((await store.listLoanRecords({ subjectId: "subject-1" }))[0]).toMatchObject({
        loanRecordId: loanRecord.loanRecordId,
        decisionId: firstDecision.decisionId
      });
    });
  });

});
