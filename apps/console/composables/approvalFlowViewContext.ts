import { inject, provide, type InjectionKey } from "vue";
import type { useApprovalFlowViewController } from "./console-approval-flow-view-controller";

export type ApprovalFlowViewContext = ReturnType<typeof useApprovalFlowViewController>;

const approvalFlowViewKey: any = Symbol("approval-flow-view") as InjectionKey<ApprovalFlowViewContext>;

export function provideApprovalFlowView(context: ApprovalFlowViewContext) : any {
  provide(approvalFlowViewKey, context);
}

export function useApprovalFlowViewContext() : any {
  const context: any = inject(approvalFlowViewKey);
  if (!context) {
    throw new Error("Approval flow view context is not available");
  }
  return context;
}
