export const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  "rejected"
]);

export function isTerminalRunStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function shouldKeepInMemoryRun({ current }) {
  return Boolean(
    current &&
      (current.status === "running" || current.status === "queued") &&
      !isTerminalRunStatus(current.status)
  );
}

export function dispatchSkipReason(run) {
  if (!run) {
    return "run_missing";
  }
  if (isTerminalRunStatus(run.status) || run.status === "awaiting_approval") {
    return `status_${run.status}`;
  }
  return "";
}

export function assertRunApprovalAllowed(run, input = {}) {
  if (run.status !== "awaiting_approval") {
    throw new Error("只有 awaiting_approval 状态的维护运行可以审批。");
  }
  const incomingHash = String(input.planHash || input.plan_hash || "").trim();
  if (!incomingHash || incomingHash !== run.planHash) {
    throw new Error("审批 planHash 不匹配，计划变更后必须重新审批。");
  }
}
