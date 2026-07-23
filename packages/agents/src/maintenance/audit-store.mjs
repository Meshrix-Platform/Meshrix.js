import { randomUUID } from "node:crypto";
import {
  getMaintenanceAgentAuditPath,
  getMaintenanceAgentRunsPath
} from "./config.mjs";
import {
  appendBoundedJsonLine,
  readJsonlTail
} from "@lico/foundation/storage/bounded-jsonl";

const MAINTENANCE_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const MAINTENANCE_RUNS_MAX_BYTES = 8 * 1024 * 1024;

const SECRET_KEY_PATTERN = /(authorization|bearer|token|password|secret|api[-_]?key|apikey|credential)/i;
const ABSOLUTE_PATH_PATTERN =
  /([A-Za-z]:\\[^"'\s,}\]]+|\/(?:Users|home|var|tmp|private|opt|srv|mnt|Volumes|etc|usr)\/[^"'\s,}\]]+)/g;

function nowIso() {
  return new Date().toISOString();
}

function redactString(value) {
  const text = String(value || "");
  const redacted = text.replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  if (redacted.length > 2000) {
    return `${redacted.slice(0, 2000)}...<truncated>`;
  }
  return redacted;
}

export function redactForMaintenanceAudit(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > 6) {
      return `<redacted-depth:${value.length}>`;
    }
    if (seen.has(value)) {
      return "<redacted-circular>";
    }
    seen.add(value);
    return value.slice(0, 100).map((item) => redactForMaintenanceAudit(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (depth > 6) {
      return "<redacted-depth>";
    }
    if (seen.has(value)) {
      return "<redacted-circular>";
    }
    seen.add(value);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        output[key] = "<redacted>";
        continue;
      }
      output[key] = redactForMaintenanceAudit(item, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

export function createMaintenanceAgentAuditStore({ userDataPath }) {
  const auditPath = getMaintenanceAgentAuditPath(userDataPath);
  const runsPath = getMaintenanceAgentRunsPath(userDataPath);

  return {
    auditPath,
    runsPath,
    async appendAudit(entry = {}) {
      const auditEntry = {
        auditId: entry.auditId || `maa_${randomUUID()}`,
        createdAt: entry.createdAt || nowIso(),
        actor: redactForMaintenanceAudit(entry.actor || null),
        action: String(entry.action || "maintenance.agent.event"),
        runId: String(entry.runId || ""),
        stepId: String(entry.stepId || ""),
        status: String(entry.status || ""),
        risk: String(entry.risk || ""),
        details: redactForMaintenanceAudit(entry.details || {})
      };
      await appendBoundedJsonLine(auditPath, auditEntry, {
        maxBytes: MAINTENANCE_AUDIT_MAX_BYTES,
        retainedBytes: MAINTENANCE_AUDIT_MAX_BYTES / 2
      });
      return auditEntry;
    },
    async appendRunSnapshot(run) {
      const snapshot = {
        recordedAt: nowIso(),
        run: redactForMaintenanceAudit(run)
      };
      await appendBoundedJsonLine(runsPath, snapshot, {
        maxBytes: MAINTENANCE_RUNS_MAX_BYTES,
        retainedBytes: MAINTENANCE_RUNS_MAX_BYTES / 2
      });
      return snapshot;
    },
    async listAudit({ limit = 100 } = {}) {
      return readJsonlTail(auditPath, {
        limit: Math.max(1, Math.min(500, Number(limit) || 100)),
        maxScanBytes: MAINTENANCE_AUDIT_MAX_BYTES / 2,
        reverse: true,
        ignoreMalformed: true
      });
    },
    async listLatestRuns({ limit = 50 } = {}) {
      const entries = await readJsonlTail(runsPath, {
        limit: 10_000,
        maxScanBytes: MAINTENANCE_RUNS_MAX_BYTES / 2,
        ignoreMalformed: true
      });
      const latest = new Map();
      for (const entry of entries) {
        const run = entry?.run;
        if (run?.runId) {
          latest.set(run.runId, run);
        }
      }
      return [...latest.values()]
        .sort((left, right) =>
          String(right.updatedAt || right.createdAt || "").localeCompare(
            String(left.updatedAt || left.createdAt || "")
          )
        )
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    }
  };
}
