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
  mcpAuthorizationDecisionCopy,
  type ApprovalFlowCard,
  mcpAuthorizationApprovalCard,
  operationPermissionDecisionCopy,
  operationPermissionApprovalCard,
} from "../../../apps/console/composables/console-approval-flow-view-controller";

const RouterLinkStub: any = defineComponent({
  name: "RouterLink",
  props: {
    to: {
      type: [String, Object],
      required: true,
    },
  },
  setup(props: any, { slots }: Record<string, any>) : any {
    return () : any =>
      h("a", { "data-router-to": JSON.stringify(props.to) }, slots.default?.());
  },
});

function mountCardList(cards: ApprovalFlowCard[]) : any {
  const approveAuthorization: any = vi.fn();
  const approvePendingOperation: any = vi.fn();
  const rejectAuthorization: any = vi.fn();
  const rejectPendingOperation: any = vi.fn();
  const Host: any = defineComponent({
    setup() : any {
      provideApprovalFlowView({
        approvalFlowCards: ref(cards),
        approvalFlowLoading: ref(false),
        approvalFlowStatus: ref("pending"),
        approvalFlowStatusOptionBarOptions: [],
        approveAuthorization,
        approvePendingOperation,
        authorizationBusy: () : any => false,
        authorizationResolution: () : any => "",
        mcpAuthorizationStatusOptionBarOptions: [],
        pendingOperationBusy: () : any => false,
        pendingOperationResolution: () : any => "",
        refreshApprovalFlow: vi.fn(),
        rejectAuthorization,
        rejectPendingOperation,
      } as any);
      return () : any => h(ApprovalFlowCardList);
    },
  });
  const wrapper: any = mount(Host, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
      },
    },
  });
  return {
    approveAuthorization,
    approvePendingOperation,
    rejectAuthorization,
    rejectPendingOperation,
    wrapper,
  };
}

describe("approval flow decision cards", () : any => {
  it("renders informed pending decisions with stable actions and protected technical details", async () : Promise<any> => {
    const mcpCard: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_example",
      requestKind: "local_mcp_install",
      status: "pending",
      clientName: "Meshrix MCP Codex",
      targets: ["codex"],
      requestedTools: ["runtime.status.read"],
      requestedScopes: ["runtime:read"],
      toolsets: ["meshrix.runtime.read"],
      maxRisk: "read_only",
      verificationCode: "ABCD-EFGH",
      processKeyFingerprints: [
        {
          target: "codex",
          fingerprint: "sha256:synthetic-fingerprint",
        },
      ],
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
    const operationCard: any = operationPermissionApprovalCard({
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
    const { approveAuthorization, approvePendingOperation, wrapper } =
      mountCardList([mcpCard, operationCard]);

    expect(
      wrapper.findAll('[data-testid="approval-request-card"]'),
    ).toHaveLength(2);
    expect(wrapper.text()).toContain("请求者");
    expect(wrapper.text()).toContain("动作");
    expect(wrapper.text()).toContain("影响");
    expect(wrapper.text()).toContain("有效期");
    expect(wrapper.text()).toContain("Operation Permission 审批");
    expect(wrapper.text()).toContain("convert-require-approval-debug");
    expect(wrapper.text()).toContain("受限写入");
    expect(wrapper.text()).not.toContain("must-not-render");

    const technicalSections: any = wrapper.findAll(
      '[data-section="technical-details"]',
    );
    expect(technicalSections).toHaveLength(2);
    expect(
      technicalSections.every(
        (section?: any) : any => section.attributes("open") === undefined,
      ),
    ).toBe(true);
    const protectedValues: any = wrapper.findAll("[data-protected]");
    expect(protectedValues.length).toBeGreaterThanOrEqual(5);
    expect(
      protectedValues.every((value?: any) : any => value.element.tagName === "DD"),
    ).toBe(true);

    await wrapper.get('[data-action="mcp-approve"]').trigger("click");
    await wrapper.get('[data-action="operation-approve"]').trigger("click");
    expect(approveAuthorization).toHaveBeenCalledTimes(1);
    expect(approvePendingOperation).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-action="mcp-approve"]').text()).toContain(
      "批准本次安装",
    );
    expect(wrapper.get('[data-action="operation-approve"]').text()).toContain(
      "批准请求",
    );
    expect(wrapper.findAll('[role="group"]').length).toBeGreaterThanOrEqual(4);
  });

  it("separates approval from execution and links terminal work to recent audit without a fake deep link", () : any => {
    const card: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_op_completed",
      toolId: "convert-require-approval-debug",
      operationId: "format-convert",
      risk: "safe_write",
      status: "completed",
      executionOutcome: "executed_once",
      toolExecutionId: "[redacted]",
      resumedToolExecutionId: "[redacted]",
      agentId: "[redacted]",
      completedAt: "2026-01-01T00:01:00.000Z",
    });
    const { wrapper } = mountCardList([card]);

    expect(card.decisionStatus.value).toBe("已批准");
    expect(card.executionStatus.value).toBe("已执行一次");
    expect(card.summary).toContain("操作已完成一次");
    expect(card.auditAvailable).toBe(true);
    expect(wrapper.text()).toContain("审批决定");
    expect(wrapper.text()).toContain("执行结果");
    expect(wrapper.text()).toContain("查看最近执行审计");
    expect(wrapper.text()).toContain("已授权调用方（身份受保护）");
    expect(wrapper.text()).not.toContain("[redacted]");
    expect(
      wrapper
        .get('[data-testid="approval-audit-link"]')
        .attributes("data-router-to"),
    ).toBe('"/admin/tool-stats"');
    expect(wrapper.html()).not.toContain("execution=");
    expect(wrapper.find('[data-action="operation-approve"]').exists()).toBe(
      false,
    );
  });

  it("uses authorization language for a non-install MCP request", () : any => {
    const card: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_generic",
      requestKind: "generic",
      status: "pending",
      clientName: "External MCP client",
      requestedTools: ["runtime.status.read"],
      requestedScopes: ["runtime:read"],
    });
    const { wrapper } = mountCardList([card]);

    expect(wrapper.get('[data-action="mcp-approve"]').text()).toContain(
      "批准本次授权",
    );
    expect(wrapper.get('[data-action="mcp-approve"]').text()).not.toContain(
      "安装",
    );
    expect(
      wrapper.get(".approval-request-card-actions").attributes("role"),
    ).toBe("group");
    expect(
      wrapper.get(".approval-request-card-actions").attributes("aria-label"),
    ).toBe("MCP 客户端授权操作");
  });

  it("maps UI filters to exact API statuses and filters resolved records semantically", () : any => {
    const consumed: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_consumed",
      status: "consumed",
      requestedTools: [],
      requestedScopes: [],
    });
    const rejected: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_rejected",
      status: "rejected",
      requestedTools: [],
      requestedScopes: [],
    });
    const completed: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_completed",
      toolId: "repo.write",
      status: "completed",
      executionOutcome: "executed_once",
    });
    const failedAfterResume: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_failed",
      toolId: "repo.write",
      status: "failed",
      resumedToolExecutionId: "[redacted]",
    });
    const expired: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_expired",
      toolId: "repo.write",
      status: "expired",
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(approvalApiStatusForUiStatus("pending")).toBe("pending");
    expect(approvalApiStatusForUiStatus("rejected")).toBe("rejected");
    expect(approvalApiStatusForUiStatus("resolved")).toBe("all");
    expect(approvalApiStatusForUiStatus("all")).toBe("all");
    expect(approvalFlowCardMatchesStatus(consumed, "resolved")).toBe(true);
    expect(consumed.executionStatus.value).toBe("已交付");
    expect(approvalFlowCardMatchesStatus(completed, "resolved")).toBe(true);
    expect(approvalFlowCardMatchesStatus(failedAfterResume, "resolved")).toBe(
      true,
    );
    expect(approvalFlowCardMatchesStatus(rejected, "resolved")).toBe(false);
    expect(approvalFlowCardMatchesStatus(rejected, "rejected")).toBe(true);
    expect(approvalFlowCardMatchesStatus(expired, "resolved")).toBe(false);
    expect(approvalFlowCardMatchesStatus(expired, "all")).toBe(true);
  });

  it("guards repeated actions per card while allowing a different card to proceed", async () : Promise<any> => {
    const guard: any = createApprovalFlowActionGuard();
    let releaseFirst!: () => void;
    const firstPending: any = new Promise<void>((resolve?: any) : any => {
      releaseFirst = resolve;
    });
    const firstResolver: any = vi.fn(async () : Promise<any> => {
      await firstPending;
      return true;
    });
    const secondResolver: any = vi.fn(async () : Promise<any> => true);

    const first: any = guard.run("authorization:first", firstResolver);
    const repeated: any = guard.run("authorization:first", firstResolver);
    const independent: any = guard.run("authorization:second", secondResolver);

    await expect(repeated).resolves.toBe(false);
    await expect(independent).resolves.toBe(true);
    expect(firstResolver).toHaveBeenCalledTimes(1);
    expect(secondResolver).toHaveBeenCalledTimes(1);
    expect(guard.isBusy("authorization:first")).toBe(true);
    releaseFirst();
    await expect(first).resolves.toBe(true);
    expect(guard.isBusy("authorization:first")).toBe(false);
  });

  it("projects complete English cards and confirmation copy without Chinese UI text", () : any => {
    const mcpRequest: Record<string, any> = {
      requestId: "mcp_auth_req_english_example",
      requestKind: "local_mcp_install" as const,
      status: "consumed" as const,
      clientName: "Example client",
      targets: ["codex"],
      requestedTools: ["repo.read"],
      requestedScopes: ["repo:read"],
      processKeyFingerprints: [
        { target: "codex", fingerprint: "sha256:example" },
      ],
      verificationCode: "AAAA-BBBB",
      maxRisk: "read_only",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const operation: Record<string, any> = {
      pendingOperationId: "pending_english",
      toolId: "repo.write",
      risk: "destructive" as const,
      status: "pending",
      agentId: "[redacted]",
      approvalLayers: ["owner", "security"],
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const mcpCard: any = mcpAuthorizationApprovalCard(mcpRequest, "en");
    const operationCard: any = operationPermissionApprovalCard(operation, "en");
    const mcpCopy: any = mcpAuthorizationDecisionCopy(mcpRequest, "approved", "en");
    const operationCopy: any = operationPermissionDecisionCopy(
      operation,
      "approved",
      "en",
    );
    const projectedUiCopy: any = JSON.stringify({
      mcp: {
        decisionStatus: mcpCard.decisionStatus,
        executionStatus: mcpCard.executionStatus,
        facts: mcpCard.facts,
        label: mcpCard.label,
        summary: mcpCard.summary,
        technicalDetails: mcpCard.technicalDetails,
        title: mcpCard.title,
      },
      mcpCopy,
      operation: {
        decisionStatus: operationCard.decisionStatus,
        executionStatus: operationCard.executionStatus,
        facts: operationCard.facts,
        label: operationCard.label,
        summary: operationCard.summary,
        technicalDetails: operationCard.technicalDetails,
        title: operationCard.title,
      },
      operationCopy,
    });

    expect(projectedUiCopy).not.toMatch(/[\u3400-\u9fff]/u);
    expect(mcpCard.executionStatus.value).toBe("Delivered");
    expect(mcpCard.summary).toContain(
      "this does not mean that any tool was executed",
    );
    expect(operationCard.title).toBe("repo.write");
    expect(operationCard.facts).toContainEqual({
      label: "Requester",
      value: "Authorized caller (identity protected)",
      protected: false,
    });
    expect(operationCard.tone).toBe("danger");
    expect(operationCopy.confirmLabel).toBe("Approve Current Layer");
    expect(operationCopy.tone).toBe("danger");
  });

  it("distinguishes same-name MCP requests in confirmation copy and describes multi-layer progress honestly", () : any => {
    const sharedRequest: Record<string, any> = {
      requestKind: "local_mcp_install" as const,
      status: "pending" as const,
      clientName: "Same client",
      targets: ["codex"],
      requestedTools: ["repo.read"],
      requestedScopes: ["repo:read"],
    };
    const firstCopy: any = mcpAuthorizationDecisionCopy(
      {
        ...sharedRequest,
        requestId: "mcp_auth_req_first",
        verificationCode: "1111-AAAA",
      },
      "approved",
      "zh-CN",
    );
    const secondCopy: any = mcpAuthorizationDecisionCopy(
      {
        ...sharedRequest,
        requestId: "mcp_auth_req_second",
        verificationCode: "2222-BBBB",
      },
      "approved",
      "zh-CN",
    );
    const multiLayer: Record<string, any> = {
      pendingOperationId: "pending_multi_layer",
      toolId: "repo.write",
      status: "pending",
      approvalLayers: ["owner", "security"],
    };
    const multiLayerCard: any = operationPermissionApprovalCard(multiLayer, "zh-CN");
    const multiLayerCopy: any = operationPermissionDecisionCopy(
      multiLayer,
      "approved",
      "zh-CN",
    );

    expect(firstCopy.message).toContain("1111-AAAA");
    expect(firstCopy.message).not.toContain("2222-BBBB");
    expect(secondCopy.message).toContain("2222-BBBB");
    expect(multiLayerCard.facts).toContainEqual({
      label: "当前审批层",
      value: "owner, security",
    });
    expect(multiLayerCard.summary).toContain("若仍需审批则进入下一层");
    expect(multiLayerCopy.confirmLabel).toBe("通过当前审批层");
    expect(multiLayerCopy.message).toContain("全部满足后才最多尝试执行一次");
    expect(isRedactedPublicValue("[redacted]")).toBe(true);
  });

  it("keeps MCP approval decisions separate from failed or expired delivery", () : any => {
    const failedAfterApproval: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_failed_after_approval",
      status: "failed",
      requestedTools: [],
      requestedScopes: [],
      resolvedAt: "2026-01-01T00:00:00.000Z",
      errorCode: "authorization_issue_interrupted",
    });
    const expiredAfterApproval: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_expired_after_approval",
      status: "expired",
      requestedTools: [],
      requestedScopes: [],
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
    const expiredBeforeDecision: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_auth_req_expired_before_decision",
      status: "expired",
      requestedTools: [],
      requestedScopes: [],
    });

    expect(failedAfterApproval.decisionStatus.value).toBe("已批准");
    expect(failedAfterApproval.executionStatus.value).toBe("交付失败");
    expect(expiredAfterApproval.decisionStatus.value).toBe("已批准");
    expect(expiredAfterApproval.executionStatus.value).toBe("交付已过期");
    expect(
      approvalFlowCardMatchesStatus(expiredAfterApproval, "resolved"),
    ).toBe(true);
    expect(expiredBeforeDecision.decisionStatus.value).toBe("已过期");
    expect(
      approvalFlowCardMatchesStatus(expiredBeforeDecision, "resolved"),
    ).toBe(false);
  });

  it("shows layered approval progress without claiming that execution occurred", () : any => {
    const advanced: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_department",
      toolId: "repo.write",
      status: "completed",
      executionOutcome: "continued_pending_approval",
      resumedToolExecutionId: "[redacted]",
    });
    const unknownLegacyOutcome: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_without_explicit_outcome",
      toolId: "repo.write",
      status: "completed",
      resumedToolExecutionId: "[redacted]",
    });

    expect(advanced.decisionStatus.value).toBe("已批准");
    expect(advanced.executionStatus.value).toBe(
      "已推进至下一审批层，尚未执行",
    );
    expect(advanced.auditAvailable).toBe(false);
    expect(unknownLegacyOutcome.executionStatus.value).toBe(
      "处理已完成，执行结果不可用",
    );
    expect(unknownLegacyOutcome.auditAvailable).toBe(false);
  });

  it("uses the public tool label for decisions while retaining the full tool identity in technical details", () : any => {
    const card: any = operationPermissionApprovalCard({
      pendingOperationId: "pending_tool_label",
      toolId:
        "upstream.svc_synthetic-instance.convert-require-approval-debug",
      toolLabel: "Convert document (approval required debug)",
      operationId: "upstream.operation.synthetic-instance",
      approvalScope: "gateway:write",
      risk: "safe_write",
      status: "pending",
    });

    expect(card.title).toBe("Convert document (approval required debug)");
    expect(card.summary).toContain("满足全部规则");
    expect(card.facts).toContainEqual({
      label: "对象",
      value: "Convert document (approval required debug)",
    });
    expect(card.facts).toContainEqual({
      label: "审批范围",
      value: "gateway:write",
    });
    expect(card.facts).not.toContainEqual(
      expect.objectContaining({ label: "当前审批层" }),
    );
    expect(card.technicalDetails).toContainEqual({
      label: "工具 ID",
      value:
        "upstream.svc_synthetic-instance.convert-require-approval-debug",
    });
    expect(
      operationPermissionDecisionCopy(
        card.pendingOperation,
        "approved",
        "zh-CN",
      ).confirmLabel,
    ).toBe("批准请求");
  });

  it("keeps client-provided MCP prose out of the localized decision summary", () : any => {
    const card: any = mcpAuthorizationApprovalCard({
      requestId: "mcp_reason_language",
      requestKind: "local_mcp_install",
      status: "consumed",
      reason: "Client supplied prose in another language.",
      requestedTools: [],
      requestedScopes: [],
    });

    expect(card.summary).toContain("授权材料已交付");
    expect(card.summary).not.toContain("Client supplied prose");
    expect(card.technicalDetails).toContainEqual({
      label: "客户端说明",
      value: "Client supplied prose in another language.",
    });
  });
});
