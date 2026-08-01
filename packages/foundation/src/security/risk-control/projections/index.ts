import {
  RISK_CONTROL_BOUNDARIES,
  RISK_CONTROL_ENVIRONMENTS,
  RISK_CONTROL_OBJECT_ORDER,
  RISK_CONTROL_OBJECTS
} from "../model/index.ts";
import { RISK_CONTROL_POINTS } from "../controls/index.ts";
import { RISK_CONTROL_PATHS } from "../paths/index.ts";

function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

export function listRiskControlBoundaries() : any {
  return clone(RISK_CONTROL_BOUNDARIES);
}

export function listRiskControlEnvironments() : any {
  return clone(RISK_CONTROL_ENVIRONMENTS);
}

export function listRiskControlObjects() : any {
  return clone(RISK_CONTROL_OBJECTS);
}

export function listRiskControlPoints({ lifecycleState = "" }: Record<string, any> = {}) : any {
  const controls: any = lifecycleState
    ? RISK_CONTROL_POINTS.filter((control?: any) : any => control.lifecycleState === lifecycleState)
    : RISK_CONTROL_POINTS;
  return clone(controls);
}

export function listRiskControlPaths() : any {
  return clone(RISK_CONTROL_PATHS);
}

export function riskControlControlsByObject({ boundaryId = "" }: Record<string, any> = {}) : any {
  const controls: any = boundaryId
    ? RISK_CONTROL_POINTS.filter((control?: any) : any => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  return RISK_CONTROL_OBJECT_ORDER.map((objectId?: any) : any => ({
    objectId,
    controls: clone(controls.filter((control?: any) : any => control.owner.objectId === objectId))
  }));
}

export function riskControlControlsByGate({ boundaryId = "" }: Record<string, any> = {}) : any {
  const controls: any = boundaryId
    ? RISK_CONTROL_POINTS.filter((control?: any) : any => control.owner.boundaryId === boundaryId)
    : RISK_CONTROL_POINTS;
  const groups: any = new Map<any, any>();
  for (const control of controls) {
    if (!groups.has(control.gate)) {
      groups.set(control.gate, []);
    }
    groups.get(control.gate).push(control);
  }
  return [...groups.entries()].map(([gate, entries]: any[]) : any => ({ gate, controls: clone(entries) }));
}

export function createRiskControlProjection() : any {
  return {
    boundaries: listRiskControlBoundaries(),
    environments: listRiskControlEnvironments(),
    objects: listRiskControlObjects(),
    controlsByObject: riskControlControlsByObject(),
    controlsByGate: riskControlControlsByGate(),
    paths: listRiskControlPaths()
  };
}
