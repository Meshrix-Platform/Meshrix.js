export const TERMINAL_STATUSES: any = new Set<any>([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  "rejected"
]);

export function isTerminalRunStatus(status?: any) : any {
  return TERMINAL_STATUSES.has(status);
}

export function shouldKeepInMemoryRun({ current }: Record<string, any>) : any {
  return Boolean(
    current &&
      (current.status === "running" || current.status === "queued") &&
      !isTerminalRunStatus(current.status)
  );
}

export function dispatchSkipReason(run?: any) : any {
  if (!run) {
    return "run_missing";
  }
  if (isTerminalRunStatus(run.status) || run.status === "awaiting_approval") {
    return `status_${run.status}`;
  }
  return "";
}

export function assertRunApprovalAllowed(run?: any, input: Record<string, any> = {}) : any {
  if (run.status !== "awaiting_approval") {
    throw new Error("只有 awaiting_approval 状态的维护运行可以审批。");
  }
  const incomingHash: any = String(input.planHash || input.plan_hash || "").trim();
  if (!incomingHash || incomingHash !== run.planHash) {
    throw new Error("审批 planHash 不匹配，计划变更后必须重新审批。");
  }
}
