import {
  RISK_CONTROL_BOUNDARIES,
  RISK_CONTROL_ENVIRONMENTS,
  RISK_CONTROL_GATES,
  RISK_CONTROL_MODEL_VERSION,
  RISK_CONTROL_OBJECTS
} from "./model/index.mjs";
import { RISK_CONTROL_CATALOGS } from "./catalogs/index.mjs";
import { RISK_CONTROL_POINTS } from "./controls/index.mjs";
import { RISK_CONTROL_PATHS } from "./paths/index.mjs";
import {
  createRiskControlProjection,
  listRiskControlBoundaries,
  listRiskControlEnvironments,
  listRiskControlObjects,
  listRiskControlPaths,
  listRiskControlPoints,
  riskControlControlsByGate,
  riskControlControlsByObject
} from "./projections/index.mjs";
import {
  appendRiskControlGateRecord,
  createRiskControlOperationEnvelope,
  validateRiskControlRegistry
} from "./registry/dsl.mjs";

export * from "./model/index.mjs";
export * from "./catalogs/index.mjs";
export * from "./registry/dsl.mjs";
export * from "./controls/index.mjs";
export * from "./paths/index.mjs";
export * from "./projections/index.mjs";

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

export function createRiskControlRuntimeEnvelope(input = {}) {
  return createRiskControlOperationEnvelope(input);
}

export function appendRiskControlRuntimeGate(envelope, input = {}) {
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
