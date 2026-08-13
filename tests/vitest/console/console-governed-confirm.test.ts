// @vitest-environment jsdom
// Governed confirm payload (REQ-011 / P2-2): one standard confirm fact
// structure — what effect, on what resource, with what authority, for how
// long, at what risk — shared by the approval flow and the REQ-010
// destructive-operation registry. Pins the payload shape (snapshot), tone
// escalation, dev guards, both locales, and the single-copy confirm + toast
// property of the approval flows.
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApprovalFlowViewController, operationPermissionDecisionCopy } from "../../../apps/console/composables/console-approval-flow-view-controller";
import { buildGovernedConfirmPayload } from "../../../apps/console/composables/console-governed-confirm-payload";
import {
  registerConsoleConfirmHost,
  settleAllConsoleConfirms,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
  useConsoleConfirmState,
} from "../../../apps/console/composables/console-confirm-controller";
import { requestDestructiveConfirm } from "../../../apps/console/composables/console-destructive-operation-registry";
import {
  clearConsoleToasts,
  useConsoleToasts,
} from "../../../apps/console/composables/console-toast-controller";

const shellContext: any = vi.hoisted(() : any => ({} as any));

vi.mock("#meshrix/console/server-console-shell-context", async () : Promise<any> => {
  const { namespaceServerConsoleShell } = await import("../../../tests/vitest/console/console-shell-test-utils");
  return {
    useServerConsoleShellContext: () : any => namespaceServerConsoleShell(shellContext),
  };
});

// No expiresAt: the deadline fact renders the deterministic dictionary fallback.
const FIXED_OPERATION: Record<string, any> = {
  pendingOperationId: "pending_governed",
  toolId: "repo.write",
  risk: "safe_write",
  status: "pending",
  agentId: "agent_synthetic",
};

const FIXED_REGISTRY_FACTS = {
  effect: "destructive.consequence.serviceDiscoveryAddressRemove",
  resource: "https://b.example.com",
  authority: "governedConfirm.authority.consoleSession",
  duration: "governedConfirm.duration.untilRevoked",
  risk: "destructive",
};

beforeEach(() : any => {
  registerConsoleConfirmHost();
});

afterEach(() : any => {
  settleAllConsoleConfirms(false);
  unregisterConsoleConfirmHost();
  clearConsoleToasts();
});

describe("governed confirm payload", () : any => {
  it("snapshots the approval payload deterministically in both locales", () : any => {
    expect(operationPermissionDecisionCopy(FIXED_OPERATION, "approved", "en")).toEqual({
      title: "Confirm Operation Permission Request",
      body: [
        "Impact: Write governed data",
        "Operation: repo.write",
        "Requester: agent_synthetic",
        "Valid Until: Not Declared",
        "Risk: Controlled Write",
        "",
        "After approval, the system re-evaluates the request; only when every rule is satisfied may execution be attempted once at most.",
      ].join("\n"),
      tone: "neutral",
      confirmLabel: "Approve Request",
      toastMessage: "The approval request was processed and the flow was re-evaluated.",
      toastTitle: "Approval Completed",
    });
    expect(operationPermissionDecisionCopy(FIXED_OPERATION, "approved", "zh-CN")).toEqual({
      title: "确认批准 Operation Permission 请求",
      body: [
        "影响：写入受治理数据",
        "操作：repo.write",
        "请求者：agent_synthetic",
        "有效期：未声明",
        "风险：受限写入",
        "",
        "批准后系统会重新评估；只有满足全部规则，才最多尝试执行一次。",
      ].join("\n"),
      tone: "neutral",
      confirmLabel: "批准请求",
      toastMessage: "审批请求已处理，流程已重新评估。",
      toastTitle: "审批已完成",
    });
  });

  it("snapshots the registry payload deterministically in both locales", () : any => {
    expect(buildGovernedConfirmPayload(FIXED_REGISTRY_FACTS, "en")).toEqual({
      title: "Confirm action",
      body: [
        "Impact: Deleting server address https://b.example.com is saved to this browser immediately.",
        "Operation: https://b.example.com",
        "Requester: This console session",
        "Valid Until: Effective until revoked",
        "Risk: Destructive",
      ].join("\n"),
      tone: "danger",
      confirmLabel: "Confirm",
      toastMessage: "Operation confirmed.",
      toastTitle: "Confirmation Complete",
    });
    expect(buildGovernedConfirmPayload(FIXED_REGISTRY_FACTS, "zh-CN")).toEqual({
      title: "确认操作",
      body: [
        "影响：即将删除服务端地址 https://b.example.com，删除会立即保存到本浏览器。",
        "操作：https://b.example.com",
        "请求者：本次控制台会话",
        "有效期：撤销前持续有效",
        "风险：破坏性操作",
      ].join("\n"),
      tone: "danger",
      confirmLabel: "确认执行",
      toastMessage: "操作已确认。",
      toastTitle: "确认完成",
    });
  });

  it("shares the identical five-fact body structure across both consumers", () : any => {
    const approvalBody: any = operationPermissionDecisionCopy(FIXED_OPERATION, "approved", "en").body;
    const registryBody: any = buildGovernedConfirmPayload(FIXED_REGISTRY_FACTS, "en").body;
    const factLabels = (body: string) : any =>
      body.split("\n").slice(0, 5).map((line: string) : any => line.split(": ")[0]);
    expect(factLabels(approvalBody)).toEqual(["Impact", "Operation", "Requester", "Valid Until", "Risk"]);
    expect(factLabels(registryBody)).toEqual(["Impact", "Operation", "Requester", "Valid Until", "Risk"]);
  });

  it("escalates the tone to danger on destructive risk and keeps others neutral", () : any => {
    expect(
      buildGovernedConfirmPayload({ ...FIXED_REGISTRY_FACTS, risk: "destructive" }, "en").tone,
    ).toBe("danger");
    expect(
      buildGovernedConfirmPayload({ ...FIXED_REGISTRY_FACTS, risk: "safe_write" }, "en").tone,
    ).toBe("neutral");
    expect(
      operationPermissionDecisionCopy(
        { ...FIXED_OPERATION, risk: "destructive" },
        "approved",
        "en",
      ).tone,
    ).toBe("danger");
  });

  it("forces danger tone on a rejected resolution", () : any => {
    const rejected: any = operationPermissionDecisionCopy(FIXED_OPERATION, "rejected", "en");
    expect(rejected.tone).toBe("danger");
    expect(rejected.confirmLabel).toBe("Reject Request");
    expect(rejected.body.endsWith("Reject this execution request?")).toBe(true);
    const rejectedZh: any = operationPermissionDecisionCopy(FIXED_OPERATION, "rejected", "zh-CN");
    expect(rejectedZh.tone).toBe("danger");
    expect(rejectedZh.confirmLabel).toBe("拒绝请求");
    expect(rejectedZh.body.endsWith("拒绝这一次执行请求？")).toBe(true);
  });

  it("throws on missing effect or resource facts in development", () : any => {
    expect(() : any =>
      buildGovernedConfirmPayload({ ...FIXED_REGISTRY_FACTS, effect: "" }, "en"),
    ).toThrow(/effect/);
    expect(() : any =>
      buildGovernedConfirmPayload({ ...FIXED_REGISTRY_FACTS, resource: "" }, "en"),
    ).toThrow(/resource/);
  });

  it("renders every payload in both locales without unresolved dictionary keys", () : any => {
    for (const locale of ["en", "zh-CN"]) {
      for (const payload of [
        operationPermissionDecisionCopy(FIXED_OPERATION, "approved", locale),
        operationPermissionDecisionCopy(FIXED_OPERATION, "rejected", locale),
        buildGovernedConfirmPayload(FIXED_REGISTRY_FACTS, locale),
      ]) {
        expect(payload.title, locale).toBeTruthy();
        expect(payload.body, locale).not.toMatch(/governedConfirm\.|destructive\.consequence\./u);
        expect(payload.confirmLabel, locale).toBeTruthy();
        expect(payload.toastMessage, locale).toBeTruthy();
        expect(payload.toastTitle, locale).toBeTruthy();
      }
    }
    expect(operationPermissionDecisionCopy(FIXED_OPERATION, "approved", "zh-CN").body).toContain("：");
    expect(operationPermissionDecisionCopy(FIXED_OPERATION, "approved", "en").body).toContain(": ");
  });

  it("omits the duration fact for the session-scoped revoke", () : any => {
    const body: any = buildGovernedConfirmPayload(
      { ...FIXED_REGISTRY_FACTS, duration: "" },
      "en",
    ).body;
    expect(body).not.toContain("Valid Until");
    expect(body.split("\n")).toHaveLength(4);
  });

  it("preserves the layer-aware approve copy and full English projection", () : any => {
    const layered: Record<string, any> = {
      pendingOperationId: "pending_layered",
      toolId: "repo.write",
      risk: "destructive",
      status: "pending",
      agentId: "[redacted]",
      approvalLayers: ["owner", "security"],
    };
    const copy: any = operationPermissionDecisionCopy(layered, "approved", "en");
    expect(JSON.stringify(copy)).not.toMatch(/[㐀-鿿]/u);
    expect(copy.confirmLabel).toBe("Approve Current Layer");
    expect(copy.tone).toBe("danger");
    expect(copy.title).toBe("Confirm Current Approval Layer");
    expect(copy.toastMessage).toBe(
      "The current approval layer was processed; the flow was re-evaluated and advanced.",
    );
    expect(copy.body).toContain("Requester: Authorized caller (identity protected)");
    expect(copy.body).toContain(
      "After approval, the system re-evaluates the request. If more approval is required it advances to the next layer; only after every layer is satisfied may execution be attempted once at most.",
    );
  });
});

describe("destructive registry confirm through the shared builder", () : any => {
  it("requests the standard fact body through the registry path", async () : Promise<any> => {
    const { currentConfirm } = useConsoleConfirmState();
    const pending: any = requestDestructiveConfirm("service-discovery.address.remove", {
      resource: "https://b.example.com",
    });
    expect(currentConfirm.value?.message).toContain("影响：即将删除服务端地址 https://b.example.com");
    expect(currentConfirm.value?.message).toContain("请求者：本次控制台会话");
    expect(currentConfirm.value?.message).toContain("风险：破坏性操作");
    expect(currentConfirm.value?.tone).toBe("danger");
    expect(currentConfirm.value?.confirmLabel).toBeTruthy();
    expect(currentConfirm.value?.requireText).toBeUndefined();
    settleConsoleConfirm(true);
    await expect(pending).resolves.toBe(true);
  });
});

describe("approval flow confirm and success toast from one copy", () : any => {
  function createApprovalFlowHarness() : any {
    const resolveOperationPermissionPendingOperation: any = vi.fn(
      async () : Promise<any> => true,
    );
    const approvalFlowConsole: any = {
      approvalFlowSelectedStatus: ref("pending"),
      isBusy: vi.fn(() : any => false),
      operationPermissionPendingOperations: ref([]),
      resolveOperationPermissionPendingOperation,
      selectApprovalFlowStatus: vi.fn(),
    };
    shellContext.approvalFlowConsole = approvalFlowConsole;
    let controller: any = null;
    const Host: any = defineComponent({
      setup() : any {
        controller = useApprovalFlowViewController();
        return () : any => null;
      },
    });
    mount(Host);
    return { approvalFlowConsole, controller, resolveOperationPermissionPendingOperation };
  }

  it("approve: confirm dialog and success toast share the payload copy", async () : Promise<any> => {
    const harness: any = createApprovalFlowHarness();
    const { currentConfirm } = useConsoleConfirmState();
    const payload: any = operationPermissionDecisionCopy(FIXED_OPERATION, "approved");

    const pending: any = harness.controller.approvePendingOperation(FIXED_OPERATION);
    expect(currentConfirm.value?.message).toBe(payload.body);
    expect(currentConfirm.value?.title).toBe(payload.title);
    expect(currentConfirm.value?.tone).toBe(payload.tone);
    expect(currentConfirm.value?.confirmLabel).toBe(payload.confirmLabel);
    settleConsoleConfirm(true);
    await pending;

    expect(harness.resolveOperationPermissionPendingOperation).toHaveBeenCalledWith(
      "pending_governed",
      "approved",
    );
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(payload.toastMessage);
    expect(toasts[0].title).toBe(payload.toastTitle);
    expect(toasts[0].tone).toBe("success");
  });

  it("reject: confirm dialog and success toast share the payload copy", async () : Promise<any> => {
    const harness: any = createApprovalFlowHarness();
    const { currentConfirm } = useConsoleConfirmState();
    const payload: any = operationPermissionDecisionCopy(FIXED_OPERATION, "rejected");

    const pending: any = harness.controller.rejectPendingOperation(FIXED_OPERATION);
    expect(currentConfirm.value?.message).toBe(payload.body);
    expect(currentConfirm.value?.title).toBe(payload.title);
    expect(currentConfirm.value?.tone).toBe(payload.tone);
    expect(currentConfirm.value?.confirmLabel).toBe(payload.confirmLabel);
    settleConsoleConfirm(true);
    await pending;

    expect(harness.resolveOperationPermissionPendingOperation).toHaveBeenCalledWith(
      "pending_governed",
      "rejected",
    );
    const { toasts } = useConsoleToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(payload.toastMessage);
    expect(toasts[0].title).toBe(payload.toastTitle);
    expect(toasts[0].tone).toBe("success");
  });

  it("does not resolve or toast when the confirm is declined", async () : Promise<any> => {
    const harness: any = createApprovalFlowHarness();
    const { currentConfirm } = useConsoleConfirmState();

    const pending: any = harness.controller.approvePendingOperation(FIXED_OPERATION);
    expect(currentConfirm.value).toBeTruthy();
    settleConsoleConfirm(false);
    await pending;

    expect(harness.resolveOperationPermissionPendingOperation).not.toHaveBeenCalled();
    expect(useConsoleToasts().toasts).toHaveLength(0);
  });
});
