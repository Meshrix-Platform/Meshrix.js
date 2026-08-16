import {
  RISK_CONTROL_BOUNDARIES,
  RISK_CONTROL_ENVIRONMENTS,
  RISK_CONTROL_GATES,
  RISK_CONTROL_MODEL_VERSION,
  RISK_CONTROL_OBJECTS
} from "./model/index.ts";
import { RISK_CONTROL_CATALOGS } from "./catalogs/index.ts";
import { RISK_CONTROL_POINTS } from "./controls/index.ts";
import { RISK_CONTROL_PATHS } from "./paths/index.ts";
import {
  createRiskControlProjection,
  listRiskControlBoundaries,
  listRiskControlEnvironments,
  listRiskControlObjects,
  listRiskControlPaths,
  listRiskControlPoints,
  riskControlControlsByGate,
  riskControlControlsByObject
} from "./projections/index.ts";
import {
  appendRiskControlGateRecord,
  createRiskControlOperationEnvelope,
  validateRiskControlRegistry
} from "./registry/dsl.ts";
import type { RiskControlGateRecord, RiskControlOperationEnvelope } from "./types.ts";

export * from "./model/index.ts";
export * from "./catalogs/index.ts";
export * from "./registry/dsl.ts";
export * from "./controls/index.ts";
export * from "./paths/index.ts";
export * from "./projections/index.ts";

export function describeRiskControlModel() {
  return {
    modelVersion: RISK_CONTROL_MODEL_VERSION,
    boundaryCount: RISK_CONTROL_BOUNDARIES.length,
    environmentCount: RISK_CONTROL_ENVIRONMENTS.length,
    objectCount: RISK_CONTROL_OBJECTS.length,
    gateCount: RISK_CONTROL_GATES.length,
    controlCount: RISK_CONTROL_POINTS.length,
    pathCount: RISK_CONTROL_PATHS.length,
    catalogs: RISK_CONTROL_CATALOGS,
    projection: createRiskControlProjection()
  };
}

export function assertRiskControlRegistryComplete() {
  validateRiskControlRegistry({
    controls: RISK_CONTROL_POINTS,
    paths: RISK_CONTROL_PATHS
  });
  return describeRiskControlModel();
}

export function createRiskControlRuntimeEnvelope(input: { operationId?: string; traceId?: string; inputHash?: string } = {}): RiskControlOperationEnvelope {
  return createRiskControlOperationEnvelope(input);
}

export function appendRiskControlRuntimeGate(envelope: RiskControlOperationEnvelope | undefined, input: Parameters<typeof appendRiskControlGateRecord>[1] = {}): RiskControlGateRecord {
  return appendRiskControlGateRecord(envelope, input);
}

export {
  createRiskControlProjection,
  listRiskControlBoundaries,
  listRiskControlEnvironments,
  listRiskControlObjects,
  listRiskControlPaths,
  listRiskControlPoints,
  riskControlControlsByGate,
  riskControlControlsByObject
};
