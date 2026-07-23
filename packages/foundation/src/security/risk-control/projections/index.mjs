import {
  RISK_CONTROL_BOUNDARIES,
  RISK_CONTROL_ENVIRONMENTS,
  RISK_CONTROL_OBJECT_ORDER,
  RISK_CONTROL_OBJECTS
} from "../model/index.mjs";
import { RISK_CONTROL_POINTS } from "../controls/index.mjs";
import { RISK_CONTROL_PATHS } from "../paths/index.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function listRiskControlBoundaries() {
  return clone(RISK_CONTROL_BOUNDARIES);
}

export function listRiskControlEnvironments() {
  return clone(RISK_CONTROL_ENVIRONMENTS);
}

export function listRiskControlObjects() {
  return clone(RISK_CONTROL_OBJECTS);
}

export function listRiskControlPoints({ lifecycleState = "" } = {}) {
  const controls = lifecycleState
    ? RISK_CONTROL_POINTS.filter((control) => control.lifecycleState === lifecycleState)
    : RISK_CONTROL_POINTS;
  return clone(controls);
}

export function listRiskControlPaths() {
  return clone(RISK_CONTROL_PATHS);
}

export function riskControlControlsByObject({ boundaryId = "" } = {}) {
  const controls = boundaryId
    ? RISK_CONTROL_POINTS.filter((control) => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  return RISK_CONTROL_OBJECT_ORDER.map((objectId) => ({
    objectId,
    controls: clone(controls.filter((control) => control.owner.objectId === objectId))
  }));
}

export function riskControlControlsByGate({ boundaryId = "" } = {}) {
  const controls = boundaryId
    ? RISK_CONTROL_POINTS.filter((control) => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  const groups = new Map();
  for (const control of controls) {
    if (!groups.has(control.gate)) {
      groups.set(control.gate, []);
    }
    groups.get(control.gate).push(control);
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
