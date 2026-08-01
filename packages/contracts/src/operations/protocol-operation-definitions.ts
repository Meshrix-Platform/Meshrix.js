import { AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS } from "./authorization-contribution-operation-definitions.ts";
import { WORKSPACE_ASSET_OPERATION_DEFINITIONS } from "./workspace-asset-operation-definitions.ts";

export const PROTOCOL_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
  ...AUTHORIZATION_CONTRIBUTION_OPERATION_DEFINITIONS,
  ...WORKSPACE_ASSET_OPERATION_DEFINITIONS
]);

export const PROTOCOL_OPERATION_IDS: any = Object.freeze(
  PROTOCOL_OPERATION_DEFINITIONS.map((operation?: any) : any => operation.id)
);
