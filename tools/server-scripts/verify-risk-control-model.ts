import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RISK_CONTROL_BOUNDARY_IDS,
  RISK_CONTROL_GATES,
  RISK_CONTROL_MODEL_VERSION,
  RISK_CONTROL_OBJECT_ORDER,
  RISK_CONTROL_POINTS,
  appendRiskControlGateRecord,
  assertRiskControlRegistryComplete,
  createRiskControlOperationEnvelope,
  riskControlControlsByObject
} from "../../packages/foundation/src/security/risk-control/index.ts";

const __filename: any = fileURLToPath(import.meta.url);
const projectRoot: any = path.resolve(path.dirname(__filename), "../..");

async function readProjectFile(relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

async function pathExists(relativePath?: any) : Promise<any> {
  try {
    await fs.access(path.join(projectRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function assertEveryObjectCovered(boundaryId?: any, label?: any) : any {
  const projection: any = riskControlControlsByObject({ boundaryId });
  assert.deepEqual(
    projection.map((entry?: any) : any => entry.objectId),
    [...RISK_CONTROL_OBJECT_ORDER],
    `${label} must project every Risk Control object in canonical order`
  );
  for (const entry of projection) {
      assert.ok(entry.controls.length > 0, `${label} must have controls for ${entry.objectId}`);
      for (const control of entry.controls) {
        assert.equal(control.owner.boundaryId, boundaryId, `${control.controlId} must remain under ${boundaryId}`);
        assert.ok(control.controlId.includes("."), `${control.controlId} must be a stable dotted Risk Control identity`);
        assert.equal(/\s|[A-Z]/.test(control.controlId), false, `${control.controlId} must use normalized lowercase dotted identity`);
        assert.ok(control.definitionDigest.startsWith("sha256:v0.0.1:strategy:risk-control-definition-2:"), `${control.controlId} must carry definitionDigest`);
        assert.ok(control.enforcedBy.id.startsWith("component."), `${control.controlId} must reference a component catalog id`);
        assert.ok(control.factSource.id.startsWith("fact."), `${control.controlId} must reference a fact source catalog id`);
      assert.ok(control.verifiedBy.every((verifier?: any) : any => verifier.id.startsWith("verifier.")), `${control.controlId} must reference verifier catalog ids`);
    }
  }
}

function assertGateCoverage() : any {
  const gates: any = new Set<any>(RISK_CONTROL_POINTS.map((control?: any) : any => control.gate));
  for (const gate of RISK_CONTROL_GATES) {
    assert.equal(gates.has(gate), true, `Risk Control Registry must cover lifecycle gate ${gate}`);
  }
}

function assertOperationEnvelopeHashChain() : any {
  const firstControl: any = RISK_CONTROL_POINTS.find((control?: any) : any => control.controlId === "client.registration.admit");
  const secondControl: any = RISK_CONTROL_POINTS.find((control?: any) : any => control.controlId === "client.mcp-grant.authorize");
  const envelope: any = createRiskControlOperationEnvelope({
    operationId: "verify.risk-control",
    traceId: "trace-risk-control-verifier",
    inputHash: "sha256:test"
  });
  const first: any = appendRiskControlGateRecord(envelope, {
    control: firstControl,
    decision: "allow",
    reasonCode: "verified",
    subject: { type: "test", subjectId: "subject-a" },
    intent: "verify risk control gate record",
    resource: { operationId: "verify.risk-control" },
    environment: { boundaryId: RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS }
  });
  const second: any = appendRiskControlGateRecord(envelope, {
    control: secondControl,
    decision: "allow",
    reasonCode: "verified",
    subject: { type: "test", subjectId: "subject-a" },
    intent: "verify risk control gate record",
    resource: { operationId: "verify.risk-control" },
    environment: { boundaryId: RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS }
  });
  assert.equal(envelope.gateRecords.length, 2);
  assert.equal(first.previousRecordDigest, envelope.operationAnchorDigest);
  assert.equal(second.previousRecordDigest, first.recordDigest);
  assert.ok(first.recordDigest.startsWith("sha256:v0.0.1:strategy:risk-control-gate-record-1:"));
  assert.ok(second.recordDigest.startsWith("sha256:v0.0.1:strategy:risk-control-gate-record-1:"));
}

async function assertRiskControlAuthority() : Promise<any> {
  assert.equal(await pathExists("packages/foundation/src/security/risk-control"), true, "Risk Control implementation home must exist");
  const productionGate: any = await readProjectFile("tools/server-scripts/production-readiness-gate.ts");
  assert.match(productionGate, /tools\/server-scripts\/verify-risk-control-model\.ts/, "production readiness gate must run the current Risk Control verifier");
}

async function assertRuntimeRiskControlEnvelope() : Promise<any> {
  const dispatcherCore: any = await readProjectFile("packages/server-runtime/src/composition/dispatch-operation-core.ts");
  const dispatcherRiskControl: any = await readProjectFile("packages/server-runtime/src/composition/dispatch-operation-risk-control.ts");
  assert.match(
    dispatcherRiskControl,
    /createRiskControlOperationEnvelope/,
    "OperationDispatcher must create a server-owned Risk Control operation envelope"
  );
  assert.match(
    dispatcherRiskControl,
    /appendRiskControlGateRecord/,
    "OperationDispatcher must append registered Risk Control gate records"
  );
  assert.match(
    dispatcherRiskControl,
    /__meshrixRiskControl/,
    "OperationDispatcher must attach the Risk Control envelope to the request lifecycle"
  );
  assert.match(
    dispatcherCore,
    /operation_authorizer_missing/,
    "OperationDispatcher must fail closed when an HTTP/RPC operation has no authorizer"
  );

  const auditStore: any = await readProjectFile("packages/foundation/src/security/operation-audit-worker-store.ts");
  assert.match(
    auditStore,
    /risk_control_envelope_json/,
    "Operation audit store must persist the Risk Control envelope evidence"
  );
  assert.match(
    auditStore,
    /risk_control_last_record_digest/,
    "Operation audit store must persist the Risk Control hash-chain tail"
  );
}

const model: any = assertRiskControlRegistryComplete();
assert.equal(model.modelVersion, RISK_CONTROL_MODEL_VERSION);
assert.ok(model.controlCount >= 60, "Risk Control Registry must cover current controls from every object group");
assert.ok(model.pathCount >= 4, "Risk Control Registry must expose end-to-end paths");
assertEveryObjectCovered(RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS, "client MCP ingress Risk Control");
assertEveryObjectCovered(RISK_CONTROL_BOUNDARY_IDS.SERVER_API_EGRESS, "server API egress Risk Control");
assertEveryObjectCovered(RISK_CONTROL_BOUNDARY_IDS.PLATFORM_SELF, "platform self Risk Control");
assertGateCoverage();
assertOperationEnvelopeHashChain();
await assertRiskControlAuthority();
await assertRuntimeRiskControlEnvelope();

const securityDoc: any = await readProjectFile("docs/functionality/SECURITY-AUTHORIZATION.md");
assert.match(securityDoc, /risk control model|风险控制模型/i, "Security functionality doc must define Risk Control Model terminology");
assert.equal(await pathExists("packages/foundation/src/security/risk-control"), true, "Risk Control implementation home must exist");

console.log("risk-control model verifier passed");
