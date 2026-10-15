import { parentPort, workerData } from "node:worker_threads";

let hostCallId = 0;
const hostCalls = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();

const readyAfterMs = Number((workerData as { readyAfterMs?: unknown } | null)?.readyAfterMs || 0);
if (readyAfterMs > 0) {
  setTimeout(() => parentPort?.postMessage({ type: "worker-ready" }), readyAfterMs);
}

parentPort?.on("message", async (message: unknown): Promise<void> => {
  const request = message as Record<string, unknown>;
  if (request.type === "host-response") {
    const id = Number(request.id);
    const pending = hostCalls.get(id);
    if (!pending) return;
    hostCalls.delete(id);
    if (request.ok === true) pending.resolve(request.result);
    else pending.reject(Object.assign(new Error("Synthetic host callback failed."), { code: "sqlite_lane_host_command_failed" }));
    return;
  }

  const reply: Record<string, unknown> = { id: request.id, ok: false };
  try {
    if (request.kind === "work") {
      const id = ++hostCallId;
      const result = await new Promise((resolve, reject) => {
        hostCalls.set(id, { resolve, reject });
        parentPort?.postMessage({ type: "host-call", id, kind: "test.wait", payload: request.payload });
      });
      reply.result = result;
    } else if (request.kind === "close") {
      reply.result = null;
    } else {
      throw Object.assign(new Error("Synthetic lane command is not allowed."), { code: "sqlite_lane_command_rejected" });
    }
    reply.ok = true;
  } catch (error) {
    reply.error = {
      name: "Error",
      code: String((error as { code?: string })?.code || "sqlite_lane_command_failed"),
      message: String((error as Error)?.message || "Synthetic lane command failed.")
    };
  }
  parentPort?.postMessage(reply);
  if (request.kind === "close" && reply.ok === true) parentPort?.close();
});
