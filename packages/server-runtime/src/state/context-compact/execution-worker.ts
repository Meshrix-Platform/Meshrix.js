import { parentPort } from "node:worker_threads";
import { normalizeConversationInput } from "./graph.ts";

interface NormalizeCommand {
  id: number;
  kind: "normalize";
  payload: Record<string, unknown>;
  deadlineAtMs: number;
}

interface LaneReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

function commandErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return fallback;
  return String((error as { code?: unknown }).code || fallback);
}

function commandErrorMessage(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("message" in error)) return fallback;
  return String((error as { message?: unknown }).message || fallback);
}

parentPort?.on("message", (message: NormalizeCommand) : void => {
  const reply: LaneReply = { id: message?.id, ok: false };
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
  } catch (error: unknown) {
    reply.error = {
      code: commandErrorCode(error, "context_compaction_lane_command_failed"),
      message: commandErrorMessage(error, "Context compaction command failed.")
    };
  }
  parentPort?.postMessage(reply);
});
