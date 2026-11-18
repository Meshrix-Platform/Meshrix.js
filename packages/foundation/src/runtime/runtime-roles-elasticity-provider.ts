import {
  assertRuntimeRolesElasticityCapabilities,
  RUNTIME_ROLES_ELASTICITY_DISCIPLINE,
  type RuntimeRoleCapability,
} from "./runtime-roles-elasticity-discipline.ts";

export const RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION = "v0.0.1:runtime:roles-elasticity-1";

export interface RuntimeRolesElasticityProvider {
  readonly protocolVersion: typeof RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION;
  listCapabilities(): {
    protocolVersion: typeof RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION;
    capabilities: RuntimeRoleCapability[];
  };
}

export function createRuntimeRolesElasticityProvider(): RuntimeRolesElasticityProvider {
  return Object.freeze({
    protocolVersion: RUNTIME_ROLES_ELASTICITY_PROTOCOL_VERSION,
    listCapabilities(): ReturnType<RuntimeRolesElasticityProvider["listCapabilities"]> {
      const capabilities: RuntimeRoleCapability[] = [
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
