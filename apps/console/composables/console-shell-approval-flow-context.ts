import type { useConsole } from "./useConsole";

type ConsoleContext = ReturnType<typeof useConsole>;

const approvalFlowShellKeys: any = [
  "approvalFlowSelectedStatus",
  "busyKey",
  "mcpAuthorizationRequests",
  "mcpAuthorizationStatus",
  "mcpAuthorizationStatusOptionBarOptions",
  "operationPermissionPendingOperations",
  "operationPermissionPendingStatus",
  "operationPermissionPendingStatusOptionBarOptions",
  "refreshMcpAuthorizationRequests",
  "refreshOperationPermissionPendingOperations",
  "resolveMcpAuthorizationRequest",
  "resolveOperationPermissionPendingOperation",
  "selectApprovalFlowStatus",
] as const satisfies readonly (keyof ConsoleContext)[];

export type ApprovalFlowShellContext = Pick<ConsoleContext, (typeof approvalFlowShellKeys)[number]>;

export function pickApprovalFlowShellContext(context: ConsoleContext): ApprovalFlowShellContext {
  return Object.fromEntries(approvalFlowShellKeys.map((key?: any) : any => [key, context[key]])) as ApprovalFlowShellContext;
}
