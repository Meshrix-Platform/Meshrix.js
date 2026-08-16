export interface RuntimeRoleCapability {
  id: string;
  kind: string;
  operations: readonly string[];
}

interface RuntimeRolesElasticityBoundary {
  control?: { previewElasticityBounds?: unknown };
  data?: { writeRolePartition?: unknown };
  workerRuntime?: { claimWorkerLease?: unknown; reportWorkerCapacity?: unknown };
}

const CONTROL_OPERATIONS = Object.freeze([
  "admitRoleWorkload",
  "scheduleRoleTopology",
  "previewElasticityBounds",
  "enforceRoleFence",
  "reportRoleTopology",
]);

const DATA_OPERATIONS = Object.freeze([
  "readRolePartition",
  "writeRolePartition",
  "commitRoleCheckpoint",
  "listRolePartitions",
]);

const WORKER_OPERATIONS = Object.freeze([
  "claimWorkerLease",
  "releaseWorkerLease",
  "reportWorkerCapacity",
  "drainWorkerRole",
]);

export const RUNTIME_ROLES_ELASTICITY_DISCIPLINE = Object.freeze({
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

function isCapability(value: unknown): value is RuntimeRoleCapability {
  return Boolean(value) && typeof value === "object"
    && typeof Reflect.get(value as object, "id") === "string"
    && typeof Reflect.get(value as object, "kind") === "string"
    && Array.isArray(Reflect.get(value as object, "operations"));
}

function capabilityById(capabilities: readonly RuntimeRoleCapability[], capabilityId: string): RuntimeRoleCapability | null {
  return capabilities.find((entry) => entry.id === capabilityId) ?? null;
}

function operationsMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation, index) => actual[index] === operation);
}

export function assertRuntimeRolesElasticityCapabilities(capabilities: unknown): true {
  if (!Array.isArray(capabilities)) {
    throw new Error("Runtime roles and elasticity capabilities must be an array.");
  }
  if (!capabilities.every(isCapability)) {
    throw new Error("Runtime roles and elasticity capabilities contain an invalid entry.");
  }
  const control = capabilityById(
    capabilities,
    RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.capabilityId,
  );
  const data = capabilityById(
    capabilities,
    RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.capabilityId,
  );
  const worker = capabilityById(
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

export function assertRuntimeRolesElasticityBoundaries({
  control,
  data,
  workerRuntime
}: RuntimeRolesElasticityBoundary = {}): true {
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
