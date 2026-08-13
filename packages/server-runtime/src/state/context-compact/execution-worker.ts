import { parentPort } from "node:worker_threads";
import { normalizeConversationInput } from "./graph.ts";

parentPort?.on("message", (message?: any) : any => {
  const reply: any = { id: message?.id, ok: false };
  try {
    if (message?.kind !== "normalize") {
      throw Object.assign(new Error("Context compaction command is not allowed."), {
        code: "context_compaction_lane_command_rejected"
      });
    }
    if (Date.now() > Number(message.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Context compaction command deadline elapsed."), {
        code: "context_compaction_lane_deadline_exceeded"
      });
    }
    reply.result = normalizeConversationInput(message.payload);
    reply.ok = true;
  } catch (error: any) {
    reply.error = {
      code: String(error?.code || "context_compaction_lane_command_failed"),
      message: String(error?.message || "Context compaction command failed.")
    };
  }
  parentPort?.postMessage(reply);
});
