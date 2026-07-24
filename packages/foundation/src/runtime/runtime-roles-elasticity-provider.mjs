import {
  assertRuntimeRolesElasticityCapabilities,
  RUNTIME_ROLES_ELASTICITY_DISCIPLINE,
} from "./runtime-roles-elasticity-discipline.mjs";

export const RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION = "v0.0.1:runtime:roles-elasticity-1";

export function createRuntimeRolesElasticityProvider() {
  return Object.freeze({
    protocolVersion: RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION,
    listCapabilities() {
      const capabilities = [
        {
          id: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.capabilityId,
          kind: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.kind,
          operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.operations],
        },
        {
          id: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.capabilityId,
          kind: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.kind,
          operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.operations],
        },
        {
          id: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.capabilityId,
          kind: RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.kind,
          operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.operations],
        },
      ];
      assertRuntimeRolesElasticityCapabilities(capabilities);
      return {
        protocolVersion: RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION,
        capabilities,
      };
    },
  });
}
