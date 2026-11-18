import {
  RISK_CONTROL_BOUNDARIES,
  RISK_CONTROL_ENVIRONMENTS,
  RISK_CONTROL_OBJECT_ORDER,
  RISK_CONTROL_OBJECTS
} from "../model/index.ts";
import { RISK_CONTROL_POINTS } from "../controls/index.ts";
import { RISK_CONTROL_PATHS } from "../paths/index.ts";
import type { RiskControlBoundary, RiskControlEnvironment, RiskControlObject, RiskControlPath, RiskControlPoint } from "../types.ts";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function listRiskControlBoundaries(): readonly RiskControlBoundary[] {
  return clone(RISK_CONTROL_BOUNDARIES);
}

export function listRiskControlEnvironments(): readonly RiskControlEnvironment[] {
  return clone(RISK_CONTROL_ENVIRONMENTS);
}

export function listRiskControlObjects(): readonly RiskControlObject[] {
  return clone(RISK_CONTROL_OBJECTS);
}

export function listRiskControlPoints({ lifecycleState = "" }: { lifecycleState?: string } = {}): readonly RiskControlPoint[] {
  const controls = lifecycleState
    ? RISK_CONTROL_POINTS.filter((control) => control.lifecycleState === lifecycleState)
    : RISK_CONTROL_POINTS;
  return clone(controls);
}

export function listRiskControlPaths(): readonly RiskControlPath[] {
  return clone(RISK_CONTROL_PATHS);
}

export function riskControlControlsByObject({ boundaryId = "" }: { boundaryId?: string } = {}) {
  const controls = boundaryId
    ? RISK_CONTROL_POINTS.filter((control) => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  return RISK_CONTROL_OBJECT_ORDER.map((objectId) => ({
    objectId,
    controls: clone(controls.filter((control) => control.owner.objectId === objectId))
  }));
}

export function riskControlControlsByGate({ boundaryId = "" }: { boundaryId?: string } = {}) {
  const controls = boundaryId
    ? RISK_CONTROL_POINTS.filter((control) => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  const groups = new Map<string, RiskControlPoint[]>();
  for (const control of controls) {
    if (!groups.has(control.gate)) {
      groups.set(control.gate, []);
    }
    groups.get(control.gate)?.push(control);
  }
  return [...groups.entries()].map(([gate, entries]) => ({ gate, controls: clone(entries) }));
}

export function createRiskControlProjection() {
  return {
    boundaries: listRiskControlBoundaries(),
    environments: listRiskControlEnvironments(),
    objects: listRiskControlObjects(),
    controlsByObject: riskControlControlsByObject(),
    controlsByGate: riskControlControlsByGate(),
    paths: listRiskControlPaths()
  };
}
