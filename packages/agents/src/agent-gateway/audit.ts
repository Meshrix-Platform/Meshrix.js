import path from "node:path";
import { nowIso } from "./shared.ts";
import { sanitizePayload } from "./projections.ts";
import { appendBoundedJsonLine } from "@meshrix/foundation/storage/bounded-jsonl";

const AGENT_GATEWAY_AUDIT_MAX_BYTES: any = 32 * 1024 * 1024;

async function appendAgentGatewayAudit({ userDataPath = "", event = {} }: Record<string, any> = {}) : Promise<any> {
  if (!userDataPath) {
    return;
  }
  const logPath: any = path.join(userDataPath, "logs", "agent-gateway.jsonl");
  try {
    await appendBoundedJsonLine(logPath, {
        ts: nowIso(),
        schemaVersion: "v0.0.1:schema:definition-1",
        component: "AgentGateway",
        ...sanitizePayload(event)
    }, {
      maxBytes: AGENT_GATEWAY_AUDIT_MAX_BYTES,
      retainedBytes: AGENT_GATEWAY_AUDIT_MAX_BYTES / 2
    });
  } catch {
    // Audit logging must never break model calls.
  }
}

export { appendAgentGatewayAudit };
