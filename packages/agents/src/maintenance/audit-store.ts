import { randomUUID } from "node:crypto";
import {
  getMaintenanceAgentAuditPath,
  getMaintenanceAgentRunsPath
} from "./config.ts";
import {
  appendBoundedJsonLine,
  readJsonlTail
} from "@meshrix/foundation/storage/bounded-jsonl";

const MAINTENANCE_AUDIT_MAX_BYTES: any = 16 * 1024 * 1024;
const MAINTENANCE_RUNS_MAX_BYTES: any = 8 * 1024 * 1024;

const SECRET_KEY_PATTERN: any = /(authorization|bearer|token|password|secret|api[-_]?key|apikey|credential)/i;
const ABSOLUTE_PATH_PATTERN: any =
  /([A-Za-z]:\\[^"'\s,}\]]+|\/(?:Users|home|var|tmp|private|opt|srv|mnt|Volumes|etc|usr)\/[^"'\s,}\]]+)/g;

function nowIso() : any {
  return new Date().toISOString();
}

function redactString(value?: any) : any {
  const text: any = String(value || "");
  const redacted: any = text.replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  if (redacted.length > 2000) {
    return `${redacted.slice(0, 2000)}...<truncated>`;
  }
  return redacted;
}

export function redactForMaintenanceAudit(value?: any, depth: any = 0, seen: any = new WeakSet<object>()) : any {
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
    return value.slice(0, 100).map((item?: any) : any => redactForMaintenanceAudit(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (depth > 6) {
      return "<redacted-depth>";
    }
    if (seen.has(value)) {
      return "<redacted-circular>";
    }
    seen.add(value);
    const output: Record<string, any> = {};
    for (const [key, item] of (Object.entries(value) as [string, any][])) {
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

export function createMaintenanceAgentAuditStore({ userDataPath }: Record<string, any>) : any {
  const auditPath: any = getMaintenanceAgentAuditPath(userDataPath);
  const runsPath: any = getMaintenanceAgentRunsPath(userDataPath);

  return {
    auditPath,
    runsPath,
    async appendAudit(entry: Record<string, any> = {}) : Promise<any> {
      const auditEntry: Record<string, any> = {
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
    async appendRunSnapshot(run?: any) : Promise<any> {
      const snapshot: Record<string, any> = {
        recordedAt: nowIso(),
        run: redactForMaintenanceAudit(run)
      };
      await appendBoundedJsonLine(runsPath, snapshot, {
        maxBytes: MAINTENANCE_RUNS_MAX_BYTES,
        retainedBytes: MAINTENANCE_RUNS_MAX_BYTES / 2
      });
      return snapshot;
    },
    async listAudit({ limit = 100 }: Record<string, any> = {}) : Promise<any> {
      return readJsonlTail(auditPath, {
        limit: Math.max(1, Math.min(500, Number(limit) || 100)),
        maxScanBytes: MAINTENANCE_AUDIT_MAX_BYTES / 2,
        reverse: true,
        ignoreMalformed: true
      });
    },
    async listLatestRuns({ limit = 50 }: Record<string, any> = {}) : Promise<any> {
      const entries: any = await readJsonlTail(runsPath, {
        limit: 10_000,
        maxScanBytes: MAINTENANCE_RUNS_MAX_BYTES / 2,
        ignoreMalformed: true
      });
      const latest: any = new Map<any, any>();
      for (const entry of entries) {
        const run: any = entry?.run;
        if (run?.runId) {
          latest.set(run.runId, run);
        }
      }
      return [...latest.values()]
        .sort((left?: any, right?: any) : any =>
          String(right.updatedAt || right.createdAt || "").localeCompare(
            String(left.updatedAt || left.createdAt || "")
          )
        )
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    }
  };
}
