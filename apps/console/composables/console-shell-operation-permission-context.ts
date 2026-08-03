import type { useConsole } from "./useConsole";

type ConsoleContext = ReturnType<typeof useConsole>;

const operationPermissionShellKeys: any = [
  "activeOperationPermissionToolCount",
  "isBusy",
  "copyIssuedToolToken",
  "createGrant",
  "deleteGrant",
  "defaultAgentToolCount",
  "enabledToolGrantCount",
  "grantHasToolset",
  "grantToolRuleState",
  "internalOperationPermissionToolCount",
  "issuedToolToken",
  "newGrantLabel",
  "newGrantScopes",
  "newGrantToolsets",
  "policyPreviewGrantId",
  "policyPreviewProfileId",
  "policyPreviewProfileOptionBarOptions",
  "policyPreviewResult",
  "policyPreviewToolId",
  "policyPreviewToolOptionBarOptions",
  "previewToolPolicy",
  "refreshOperationPermission",
  "rotateGrant",
  "selectOperationPermissionToolset",
  "selectToolForManagement",
  "selectedOperationPermissionTool",
  "selectedOperationPermissionToolId",
  "selectedOperationPermissionToolset",
  "selectedOperationPermissionToolsetId",
  "selectedOperationPermissionToolsetTools",
  "setGrantToolRule",
  "toggleGrantToolset",
  "toggleNewGrantToolset",
  "toolGrants",
  "operationPermissionAuditItems",
  "operationPermissionCatalogState",
  "operationPermissionMetricsState",
  "operationPermissionProfiles",
  "operationPermissionRiskRows",
  "operationPermissionStatusRows",
  "operationPermissionToolGroups",
  "operationPermissionTools",
  "operationPermissionToolsets",
  "toolScopes",
  "updateGrant",
] as const satisfies readonly (keyof ConsoleContext)[];

export type OperationPermissionShellContext = Pick<ConsoleContext, (typeof operationPermissionShellKeys)[number]>;

export function pickOperationPermissionShellContext(context: ConsoleContext): OperationPermissionShellContext {
  return Object.fromEntries(operationPermissionShellKeys.map((key?: any) : any => [key, context[key]])) as OperationPermissionShellContext;
}
