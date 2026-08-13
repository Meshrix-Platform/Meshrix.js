import { parentPort } from "node:worker_threads";

const pending: any = new Map<any, any>();
let sequence: any = 0;
let activeDeadlineAtMs: any = Number.MAX_SAFE_INTEGER;

parentPort?.on("message", (message?: any) : any => {
  if (message?.type !== "host-response") return;
  const entry: any = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else {
    const error: any = new Error(String(message.error?.message || "Operation Permission host command failed."));
    error.name = String(message.error?.name || "Error");
    error.code = String(message.error?.code || "sqlite_lane_host_command_failed");
    if (Number(message.error?.statusCode || 0) > 0) {
      error.statusCode = Number(message.error.statusCode);
    }
    error.details = message.error?.details && typeof message.error.details === "object"
      ? Object.freeze({ ...message.error.details })
      : Object.freeze({});
    entry.reject(error);
  }
});

export function callOperationPermissionHost(kind?: any, payload: Record<string, any> = {}) : Promise<any> {
  const id: any = ++sequence;
  return new Promise((resolve?: any, reject?: any) : any => {
    const remainingMs: any = Math.max(1, activeDeadlineAtMs - Date.now());
    const timer: any = setTimeout(() : any => {
      if (!pending.delete(id)) return;
      const error: any = new Error("Operation Permission host command deadline elapsed.");
      error.code = "sqlite_lane_deadline_exceeded";
      reject(error);
    }, remainingMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    parentPort?.postMessage(Object.freeze({
      type: "host-call",
      id,
      kind: String(kind || ""),
      payload: structuredClone(payload)
    }));
  });
}

export function setOperationPermissionCommandDeadline(deadlineAtMs?: any) : void {
  activeDeadlineAtMs = Number.isFinite(Number(deadlineAtMs))
    ? Number(deadlineAtMs)
    : Number.MAX_SAFE_INTEGER;
}
