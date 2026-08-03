import type { useConsole } from "./useConsole";

type ConsoleContext = ReturnType<typeof useConsole>;

const approvalFlowShellKeys: any = [
  "approvalFlowSelectedStatus",
  "isBusy",
  "operationPermissionPendingOperations",
  "operationPermissionPendingStatus",
  "operationPermissionPendingStatusOptionBarOptions",
  "refreshOperationPermissionPendingOperations",
  "resolveOperationPermissionPendingOperation",
  "selectApprovalFlowStatus",
] as const satisfies readonly (keyof ConsoleContext)[];

export type ApprovalFlowShellContext = Pick<ConsoleContext, (typeof approvalFlowShellKeys)[number]>;

export function pickApprovalFlowShellContext(context: ConsoleContext): ApprovalFlowShellContext {
  return Object.fromEntries(approvalFlowShellKeys.map((key?: any) : any => [key, context[key]])) as ApprovalFlowShellContext;
}
