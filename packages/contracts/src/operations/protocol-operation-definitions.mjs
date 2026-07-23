import { AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS } from "./authorization-contribution-operation-definitions.mjs";
import { WORKSPACE_ASSET_OPERATION_DEFINITIONS } from "./workspace-asset-operation-definitions.mjs";

export const PROTOCOL_OPERATION_DEFINITIONS = Object.freeze([
  ...AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS,
  ...WORKSPACE_ASSET_OPERATION_DEFINITIONS
]);

export const PROTOCOL_OPERATION_IDS = Object.freeze(
  PROTOCOL_OPERATION_DEFINITIONS.map((operation) => operation.id)
);
