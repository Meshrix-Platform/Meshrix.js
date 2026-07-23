import path from "node:path";
import { nowIso } from "./shared.mjs";
import { sanitizePayload } from "./projections.mjs";
import { appendBoundedJsonLine } from "@lico/foundation/storage/bounded-jsonl";

const AGENT_GATEWAY_AUDIT_MAX_BYTES = 32 * 1024 * 1024;

async function appendAgentGatewayAudit({ userDataPath = "", event = {} } = {}) {
  if (!userDataPath) {
    return;
  }
  const logPath = path.join(userDataPath, "logs", "agent-gateway.jsonl");
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
