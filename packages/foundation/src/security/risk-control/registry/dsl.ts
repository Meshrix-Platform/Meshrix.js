import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";
import {
  RISK_CONTROL_DEFINITION_STATES,
  RISK_CONTROL_GATES,
  RISK_CONTROL_MODEL_VERSION,
  knownRiskControlBoundaryIds,
  knownRiskControlEnvironmentIds,
  knownRiskControlObjectIds
} from "../model/index.ts";
import {
  RISK_CONTROL_CATALOG_INDEXES,
  activeCatalogRef,
  riskControlDigest
} from "../catalogs/index.ts";

const DEFINITION_VERSION_PATTERN: any = /^v1:m\d+\.d\d+\.l\d+\.c\d+\.r\d+$/;
const CONTROL_ID_PATTERN: any = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;


export function canonicalRiskControlJson(value?: any) : any {
  return canonicalJson(value);
}

export function digestRiskControlValue(prefix?: any, value?: any) : any {
  return riskControlDigest(prefix, value);
}

function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

function strings(value?: any) : any {
  return Array.isArray(value) ? value.map((item?: any) : any => String(item || "").trim()).filter(Boolean) : [];
}

function evidenceDefaults(input: Record<string, any> = {}) : any {
  return {
    store: input.store || activeCatalogRef("evidenceStore", "store.operation-audit"),
    classificationProfile: input.classificationProfile || activeCatalogRef("evidenceProfile", "profile.classification.internal"),
    redactionPolicyProfile: input.redactionPolicyProfile || activeCatalogRef("evidenceProfile", "profile.redaction.standard"),
    retentionProfile: input.retentionProfile || activeCatalogRef("evidenceProfile", "profile.retention.audit-standard"),
    requiredFields: strings(input.requiredFields || ["traceId", "decision", "reasonCode"]),
    locatorRequired: input.locatorRequired !== false
  };
}

function normalizedControlBody(input: Record<string, any> = {}) : any {
  return {
    controlId: String(input.controlId || "").trim(),
    definitionVersion: String(input.definitionVersion || RISK_CONTROL_MODEL_VERSION).trim(),
    lifecycleState: String(input.lifecycleState || "active").trim(),
    owner: {
      boundaryId: String(input.owner?.boundaryId || "").trim(),
      environmentId: String(input.owner?.environmentId || "").trim(),
      objectId: String(input.owner?.objectId || "").trim()
    },
    gate: String(input.gate || "").trim(),
    enforcedBy: input.enforcedBy,
    factSource: input.factSource,
    binds: strings(input.binds),
    decision: {
      allow: input.decision?.allow !== false,
      deny: input.decision?.deny !== false,
      needsApproval: input.decision?.needsApproval === true,
      degraded: input.decision?.degraded === true
    },
    failsClosed: {
      reasonCode: String(input.failsClosed?.reasonCode || "").trim(),
      status: Number(input.failsClosed?.status || 403)
    },
    evidence: evidenceDefaults(input.evidence),
    verifiedBy: Array.isArray(input.verifiedBy) ? input.verifiedBy : []
  };
}

export function definitionDigestInput(control: Record<string, any> = {}) : any {
  const {
    displayName: _displayName,
    description: _description,
    docsUrl: _docsUrl,
    sortOrder: _sortOrder,
    definitionDigest: _definitionDigest,
    ...body
  } = control;
  return body;
}

export function computeDefinitionDigest(control: Record<string, any> = {}) : any {
  return digestRiskControlValue("v0.0.1:strategy:risk-control-definition-2", definitionDigestInput(control));
}

export function defineRiskControlPoint(input: Record<string, any> = {}) : any {
  const body: any = normalizedControlBody(input);
  const control: Record<string, any> = {
    ...body,
    displayName: String(input.displayName || body.controlId).trim(),
    description: String(input.description || "").trim(),
    docsUrl: String(input.docsUrl || "").trim(),
    sortOrder: Number(input.sortOrder || 0)
  };
  control.definitionDigest = computeDefinitionDigest(control);
  return Object.freeze(control);
}

function assertRef(kind?: any, ref?: any, errors?: any, controlId?: any) : any {
  const entry: any = RISK_CONTROL_CATALOG_INDEXES[kind]?.get(ref?.id);
  if (!entry) {
    errors.push(`${controlId} references unknown ${kind}: ${ref?.id || "(missing)"}`);
    return;
  }
  if (entry.lifecycle !== "active") {
    errors.push(`${controlId} references non-active ${kind}: ${entry.id}`);
  }
  if (entry.version !== ref.version || entry.digest !== ref.digest) {
    errors.push(`${controlId} has stale ${kind} reference: ${entry.id}`);
  }
}

export function validateRiskControlRegistry({ controls = [], paths = [] }: Record<string, any> = {}) : any {
  const errors: any[] = [];
  const boundaryIds: any = knownRiskControlBoundaryIds();
  const environmentIds: any = knownRiskControlEnvironmentIds();
  const objectIds: any = knownRiskControlObjectIds();
  const gates: any = new Set<any>(RISK_CONTROL_GATES);
  const states: any = new Set<any>(RISK_CONTROL_DEFINITION_STATES);
  const ids: any = new Map<any, any>();

  for (const control of controls) {
    const id: any = control.controlId || "";
    if (!CONTROL_ID_PATTERN.test(id)) {
      errors.push(`Invalid Risk Control controlId: ${id || "(missing)"}`);
    }
    if (/\s/.test(id) || /[A-Z]/.test(id)) {
      errors.push(`Risk Control controlId must not preserve a legacy label: ${id}`);
    }
    if (ids.has(id)) {
      errors.push(`Duplicate Risk Control controlId: ${id}`);
    }
    ids.set(id, control);
    if (!DEFINITION_VERSION_PATTERN.test(control.definitionVersion || "")) {
      errors.push(`${id} has invalid definitionVersion ${control.definitionVersion || "(missing)"}`);
    }
    if (!states.has(control.lifecycleState)) {
      errors.push(`${id} has invalid lifecycleState ${control.lifecycleState || "(missing)"}`);
    }
    if (!boundaryIds.has(control.owner?.boundaryId)) {
      errors.push(`${id} has unknown owner.boundaryId ${control.owner?.boundaryId || "(missing)"}`);
    }
    if (!environmentIds.has(control.owner?.environmentId)) {
      errors.push(`${id} has unknown owner.environmentId ${control.owner?.environmentId || "(missing)"}`);
    }
    if (!objectIds.has(control.owner?.objectId)) {
      errors.push(`${id} has unknown owner.objectId ${control.owner?.objectId || "(missing)"}`);
    }
    if (!gates.has(control.gate)) {
      errors.push(`${id} has invalid gate ${control.gate || "(missing)"}`);
    }
    if (!control.failsClosed?.reasonCode) {
      errors.push(`${id} is missing failsClosed.reasonCode`);
    }
    assertRef("enforcedBy", control.enforcedBy, errors, id);
    assertRef("factSource", control.factSource, errors, id);
    assertRef("evidenceStore", control.evidence?.store, errors, id);
    assertRef("evidenceProfile", control.evidence?.classificationProfile, errors, id);
    assertRef("evidenceProfile", control.evidence?.redactionPolicyProfile, errors, id);
    assertRef("evidenceProfile", control.evidence?.retentionProfile, errors, id);
    if (!Array.isArray(control.verifiedBy) || control.verifiedBy.length === 0) {
      errors.push(`${id} is missing verifiedBy`);
    } else {
      for (const verifierRef of control.verifiedBy) {
        assertRef("verifiedBy", verifierRef, errors, id);
      }
    }
    const expectedDigest: any = computeDefinitionDigest(control);
    if (control.definitionDigest !== expectedDigest) {
      errors.push(`${id} definitionDigest mismatch`);
    }
  }

  const activeIds: any = new Set<any>(controls.filter((control?: any) : any => control.lifecycleState === "active").map((control?: any) : any => control.controlId));
  for (const path of paths) {
    if (!path.pathId || !Array.isArray(path.controls) || path.controls.length === 0) {
      errors.push(`Invalid Risk Control path ${path.pathId || "(missing)"}`);
      continue;
    }
    for (const controlId of path.controls) {
      if (!activeIds.has(controlId)) {
        errors.push(`Risk Control path ${path.pathId} references missing or non-active control ${controlId}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Risk Control Registry is invalid:\n${errors.map((error?: any) : any => `- ${error}`).join("\n")}`);
  }
  return true;
}

export function createRiskControlGateRecord({
  envelopeId = "",
  previousRecordDigest = "",
  control,
  gate = control?.gate || "",
  decision = "allow",
  reasonCode = "",
  subject = {},
  intent = "",
  resource = {},
  environment = {},
  evidence = [],
  occurredAt = new Date().toISOString()
}: Record<string, any> = {}) : any {
  if (!control?.controlId) {
    throw new Error("Risk Control Gate Record requires a registered control.");
  }
  const body: Record<string, any> = {
    recordVersion: "v0.0.1:strategy:risk-control-gate-record-1",
    envelopeId: String(envelopeId || "").trim(),
    previousRecordDigest: String(previousRecordDigest || "").trim(),
    controlRef: {
      controlId: control.controlId,
      definitionVersion: control.definitionVersion,
      definitionDigest: control.definitionDigest
    },
    gate,
    decision,
    reasonCode: reasonCode || control.failsClosed?.reasonCode || "",
    subject: clone(subject),
    intent: String(intent || "").trim(),
    resource: clone(resource),
    environment: clone(environment),
    enforcedBy: control.enforcedBy,
    factSource: control.factSource,
    evidence: clone(evidence),
    occurredAt
  };
  const recordDigest: any = digestRiskControlValue("v0.0.1:strategy:risk-control-gate-record-1", body);
  return Object.freeze({
    ...body,
    recordDigest
  });
}

export function createRiskControlOperationEnvelope({ operationId = "", traceId = "", inputHash = "" }: Record<string, any> = {}) : any {
  const anchor: Record<string, any> = {
    envelopeVersion: "v0.0.1:strategy:risk-control-operation-envelope-1",
    operationId: String(operationId || "").trim(),
    traceId: String(traceId || "").trim(),
    inputHash: String(inputHash || "").trim()
  };
  return {
    ...anchor,
    operationAnchorDigest: `sha256:v0.0.1:strategy:risk-control-operation-anchor-1:${createHash("sha256").update(`v0.0.1:strategy:risk-control-operation-anchor-1\n${canonicalJson(anchor)}`).digest("hex")}`,
    gateRecords: []
  };
}

export function appendRiskControlGateRecord(envelope?: any, recordInput: Record<string, any> = {}) : any {
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.gateRecords)) {
    throw new Error("appendRiskControlGateRecord requires a Risk Control operation envelope.");
  }
  const previousRecordDigest: any = envelope.gateRecords.at(-1)?.recordDigest || envelope.operationAnchorDigest || "";
  const record: any = createRiskControlGateRecord({
    ...recordInput,
    envelopeId: envelope.operationAnchorDigest,
    previousRecordDigest
  });
  envelope.gateRecords.push(record);
  return record;
}
