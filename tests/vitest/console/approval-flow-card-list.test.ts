// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import ApprovalFlowCardList from "../../../apps/console/components/approval/ApprovalFlowCardList.vue";
import { provideApprovalFlowView } from "../../../apps/console/composables/approvalFlowViewContext";
import {
  approvalApiStatusForUiStatus,
  approvalFlowCardMatchesStatus,
  createApprovalFlowActionGuard,
  isRedactedPublicValue,
  operationPermissionDecisionCopy,
  operationPermissionApprovalCard,
  type ApprovalFlowCard,
} from "../../../apps/console/composables/console-approval-flow-view-controller";

const RouterLinkStub: any = defineComponent({
  name: "RouterLink",
  props: { to: { type: [String, Object], required: true } },
  setup(props: any, { slots }: Record<string, any>) : any {
    return () : any => h("a", { "data-router-to": JSON.stringify(props.to) }, slots.default?.());
  },
});

function mountCardList(cards: ApprovalFlowCard[]) : any {
  const approvePendingOperation: any = vi.fn(async () : Promise<any> => true);
  const rejectPendingOperation: any = vi.fn(async () : Promise<any> => true);
  const Host: any = defineComponent({
    setup() : any {
      provideApprovalFlowView({
        approvalFlowCards: ref(cards),
        approvalFlowLoading: ref(false),
        approvalFlowStatus: ref("pending"),
        approvalFlowStatusOptionBarOptions: [],
        approvePendingOperation,
        pendingOperationBusy: () : any => false,
        pendingOperationResolution: () : any => "",
        refreshApprovalFlow: vi.fn(),
        rejectPendingOperation,
      } as any);
      return () : any => h(ApprovalFlowCardList);
    },
  });
  return {
    approvePendingOperation,
    rejectPendingOperation,
    wrapper: mount(Host, { global: { stubs: { RouterLink: RouterLinkStub } } }),
  };
}

describe("governed operation approval cards", () : any => {
  it("renders one pending operation with stable approve and reject actions", async () : Promise<any> => {
    const card: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_op_example",
      toolId: "convert-require-approval-debug",
      operationId: "format-convert",
      risk: "safe_write",
      riskReason: "Writes one converted artifact",
      agentId: "agent_synthetic",
      status: "pending",
      expiresAt: "2026-01-01T00:15:00.000Z",
      context: { privateValue: "must-not-render" },
      redactedInput: { document: "must-not-render" },
    });
    const { approvePendingOperation, rejectPendingOperation, wrapper } = mountCardList([card]);

    expect(wrapper.findAll('[data-testid="approval-request-card"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("Operation Permission 审批");
    expect(wrapper.text()).toContain("convert-require-approval-debug");
    expect(wrapper.text()).toContain("受限写入");
    expect(wrapper.text()).not.toContain("must-not-render");
    expect(wrapper.find('[data-action="mcp-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="mcp-reject"]').exists()).toBe(false);

    await wrapper.get('[data-action="operation-approve"]').trigger("click");
    await wrapper.get('[data-action="operation-reject"]').trigger("click");
    expect(approvePendingOperation).toHaveBeenCalledTimes(1);
    expect(rejectPendingOperation).toHaveBeenCalledTimes(1);
  });

  it("separates approval from execution and links terminal work to recent audit", () : any => {
    const card: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_op_completed",
      toolId: "convert-require-approval-debug",
      status: "completed",
      executionOutcome: "executed_once",
      resumedToolExecutionId: "[redacted]",
      agentId: "[redacted]",
    });
    const { wrapper } = mountCardList([card]);

    expect(card.decisionStatus.value).toBe("已批准");
    expect(card.executionStatus.value).toBe("已执行一次");
    expect(wrapper.text()).toContain("查看最近执行审计");
    expect(wrapper.text()).toContain("已授权调用方（身份受保护）");
    expect(wrapper.text()).not.toContain("[redacted]");
    expect(wrapper.get('[data-testid="approval-audit-link"]').attributes("data-router-to")).toBe('"/admin/tool-stats"');
  });

  it("maps UI filters to pending-operation API statuses and terminal semantics", () : any => {
    const completed: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_completed",
      toolId: "repo.write",
      status: "completed",
      executionOutcome: "executed_once",
    });
    const rejected: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_rejected",
      toolId: "repo.write",
      status: "rejected",
    });
    const expired: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_expired",
      toolId: "repo.write",
      status: "expired",
    });

    expect(approvalApiStatusForUiStatus("pending")).toBe("pending");
    expect(approvalApiStatusForUiStatus("rejected")).toBe("rejected");
    expect(approvalApiStatusForUiStatus("resolved")).toBe("all");
    expect(approvalFlowCardMatchesStatus(completed, "resolved")).toBe(true);
    expect(approvalFlowCardMatchesStatus(rejected, "rejected")).toBe(true);
    expect(approvalFlowCardMatchesStatus(expired, "resolved")).toBe(false);
    expect(approvalFlowCardMatchesStatus(expired, "all")).toBe(true);
  });

  it("guards repeated actions per operation while allowing an independent operation", async () : Promise<any> => {
    const guard: any = createApprovalFlowActionGuard();
    let releaseFirst!: () => void;
    const firstPending: any = new Promise<void>((resolve?: any) : any => { releaseFirst = resolve; });
    const firstResolver: any = vi.fn(async () : Promise<any> => { await firstPending; return true; });
    const secondResolver: any = vi.fn(async () : Promise<any> => true);

    const first: any = guard.run("pendingOperation:first", firstResolver);
    const repeated: any = guard.run("pendingOperation:first", firstResolver);
    const independent: any = guard.run("pendingOperation:second", secondResolver);

    await expect(repeated).resolves.toBe(false);
    await expect(independent).resolves.toBe(true);
    expect(guard.isBusy("pendingOperation:first")).toBe(true);
    releaseFirst();
    await expect(first).resolves.toBe(true);
    expect(guard.isBusy("pendingOperation:first")).toBe(false);
  });

  it("projects complete English operation copy and multi-layer progress", () : any => {
    const operation: Record<string, any> = {
      pendingOperationId: "pending_english",
      toolId: "repo.write",
      risk: "destructive",
      status: "pending",
      agentId: "[redacted]",
      approvalLayers: ["owner", "security"],
    };
    const card: any = operationPermissionApprovalCard(operation, "en");
    const copy: any = operationPermissionDecisionCopy(operation, "approved", "en");

    expect(JSON.stringify({ card, copy })).not.toMatch(/[\u3400-\u9fff]/u);
    expect(card.title).toBe("repo.write");
    expect(card.tone).toBe("danger");
    expect(copy.confirmLabel).toBe("Approve Current Layer");
    expect(copy.tone).toBe("danger");
    expect(isRedactedPublicValue("[redacted]")).toBe(true);
  });

  it("shows layered approval progress without claiming execution occurred", () : any => {
    const advanced: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_department",
      toolId: "repo.write",
      status: "completed",
      executionOutcome: "continued_pending_approval",
      resumedToolExecutionId: "[redacted]",
    });

    expect(advanced.decisionStatus.value).toBe("已批准");
    expect(advanced.executionStatus.value).toBe("已推进至下一审批层，尚未执行");
    expect(advanced.auditAvailable).toBe(false);
  });
});
