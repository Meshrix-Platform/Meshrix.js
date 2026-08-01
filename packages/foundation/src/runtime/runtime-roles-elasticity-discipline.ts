const CONTROL_OPERATIONS: readonly any[] = Object.freeze([
  "admitRoleWorkload",
  "scheduleRoleTopology",
  "previewElasticityBounds",
  "enforceRoleFence",
  "reportRoleTopology",
]);

const DATA_OPERATIONS: readonly any[] = Object.freeze([
  "readRolePartition",
  "writeRolePartition",
  "commitRoleCheckpoint",
  "listRolePartitions",
]);

const WORKER_OPERATIONS: readonly any[] = Object.freeze([
  "claimWorkerLease",
  "releaseWorkerLease",
  "reportWorkerCapacity",
  "drainWorkerRole",
]);

export const RUNTIME_ROLES_ELASTICITY_DISCIPLINE: Readonly<Record<string, any>> = Object.freeze({
  id: "runtime-roles-elasticity",
  controlRole: Object.freeze({
    capabilityId: "runtime-control",
    kind: "control",
    operations: CONTROL_OPERATIONS,
  }),
  dataRole: Object.freeze({
    capabilityId: "runtime-data",
    kind: "data",
    operations: DATA_OPERATIONS,
  }),
  workerRole: Object.freeze({
    capabilityId: "runtime-worker",
    kind: "worker",
    operations: WORKER_OPERATIONS,
  }),
  elasticity: Object.freeze({
    scaleDecisionOwner: "runtime-control",
    maxReplicas: "configured-ceiling",
    workerSelfPromotion: "forbidden",
    unboundedScale: "forbidden",
  }),
  separation: Object.freeze({
    orchestrationDecisions: "runtime-control",
    stateAuthority: "runtime-data",
    executionLayer: "runtime-worker",
    workerPromotionToAuthority: "forbidden",
  }),
});

function capabilityById(capabilities?: any, capabilityId?: any) : any {
  return capabilities.find((entry?: any) : any => entry?.id === capabilityId) ?? null;
}

function operationsMatch(actual?: any, expected?: any) : any {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation?: any, index?: any) : any => actual[index] === operation);
}

export function assertRuntimeRolesElasticityCapabilities(capabilities?: any) : any {
  if (!Array.isArray(capabilities)) {
    throw new Error("Runtime roles and elasticity capabilities must be an array.");
  }
  const control: any = capabilityById(
    capabilities,
    RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.capabilityId,
  );
  const data: any = capabilityById(
    capabilities,
    RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.capabilityId,
  );
  const worker: any = capabilityById(
    capabilities,
    RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.capabilityId,
  );
  if (!control || control.kind !== RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.kind) {
    throw new Error("Runtime control must remain behind the governed control-plane capability.");
  }
  if (!data || data.kind !== RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.kind) {
    throw new Error("Runtime data must remain behind the governed data-plane capability.");
  }
  if (!worker || worker.kind !== RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.kind) {
    throw new Error("Runtime workers must remain behind the bounded worker capability.");
  }
  if (!operationsMatch(control.operations, RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.operations)) {
    throw new Error("Runtime control operations changed without updating the control-plane contract.");
  }
  if (!operationsMatch(data.operations, RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.operations)) {
    throw new Error("Runtime data operations changed without updating the data-plane contract.");
  }
  if (!operationsMatch(worker.operations, RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.operations)) {
    throw new Error("Runtime worker operations changed without updating the worker contract.");
  }
  return true;
}

export function assertRuntimeRolesElasticityBoundaries({ control, data, workerRuntime }: Record<string, any> = {}) : any {
  if (!control || typeof control.previewElasticityBounds !== "function") {
    throw new Error("Bounded elasticity requires a control plane with previewElasticityBounds.");
  }
  if (!data || typeof data.writeRolePartition !== "function") {
    throw new Error("Runtime data authority requires a data plane with writeRolePartition.");
  }
  if (!workerRuntime || typeof workerRuntime.claimWorkerLease !== "function") {
    throw new Error("Bounded worker execution requires a worker runtime with claimWorkerLease.");
  }
  if (typeof workerRuntime.reportWorkerCapacity !== "function") {
    throw new Error("Bounded worker execution requires a worker runtime with reportWorkerCapacity.");
  }
  return true;
}
