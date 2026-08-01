import crypto from "node:crypto";
import path from "node:path";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../storage/private-sqlite.ts";
import { ServerConfig } from "../config/server-config.ts";
import {
  activateAlertRecord,
  createAlertRecord,
  transitionAlertRecord
} from "../observability/alert-service.ts";
import {
  ALERT_LIFECYCLE_STATES,
  sanitizeAlertText,
  stableAlertReference
} from "../observability/alert-contract.ts";
import {
  finalizeSensitiveReport,
  sanitizeSensitiveReport
} from "../observability/sensitive-report-scan.ts";
import { OBSERVABILITY_BUDGETS } from "../observability/observability-budgets.ts";

export const SECURITY_ALERTS_PROTOCOL_VERSION: any = "v0.0.1:security:alerts-1";

function nowIso() : any {
  return new Date().toISOString();
}

function text(value: any = "") : any {
  return String(value || "").trim();
}

function asObject(value: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function randomId(prefix: any = "alert") : any {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function resolveDataDir(userDataPath: any = "") : any {
  return path.resolve(text(userDataPath) || ServerConfig.getDataDir());
}

export function getSecurityAlertsDatabasePath(userDataPath: any = "") : any {
  return path.join(resolveDataDir(userDataPath), "security", "alerts", "security-alerts.sqlite");
}

function ensureSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS security_alerts (
      alert_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_ref TEXT NOT NULL DEFAULT '',
      subject_ref TEXT NOT NULL DEFAULT '',
      resource_ref TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      trace_id TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      lifecycle_revision INTEGER NOT NULL DEFAULT 0,
      lifecycle_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT '',
      acknowledged_by TEXT NOT NULL DEFAULT '',
      retention_archived_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_security_alerts_created ON security_alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_security_alerts_status ON security_alerts(status);
    CREATE INDEX IF NOT EXISTS idx_security_alerts_reason ON security_alerts(reason_code);
    CREATE INDEX IF NOT EXISTS idx_security_alerts_trace ON security_alerts(trace_id);
  `);
  const columns: any = new Set<any>(db.prepare("PRAGMA table_info(security_alerts)").all().map((column?: any) : any => column.name));
  if (!columns.has("lifecycle_revision")) {
    db.exec("ALTER TABLE security_alerts ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("lifecycle_json")) {
    db.exec("ALTER TABLE security_alerts ADD COLUMN lifecycle_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.has("retention_archived_at")) {
    db.exec("ALTER TABLE security_alerts ADD COLUMN retention_archived_at TEXT NOT NULL DEFAULT ''");
  }
}

function parseJson(value?: any, fallback: Record<string, any> = {}) : any {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function redactSecurityAlertValue(value?: any) : any {
  return sanitizeSensitiveReport(value);
}

function normalizeSeverity(value: any = "medium") : any {
  const severity: any = text(value || "medium").toLowerCase();
  return ["info", "low", "medium", "high", "critical"].includes(severity) ? severity : "medium";
}

function alertSeverity(value: any = "medium") : any {
  const severity: any = normalizeSeverity(value);
  if (severity === "critical") return "critical";
  if (["info", "low"].includes(severity)) return "info";
  return "warning";
}

function lifecycleRecordFromRow(row: Record<string, any> = {}) : any {
  const stored: any = parseJson(row.lifecycle_json, {});
  return {
    alertId: row.alert_id,
    ruleId: row.reason_code,
    category: row.category,
    severity: alertSeverity(row.severity),
    title: row.title,
    message: row.title,
    source: "security_alert",
    role: "security",
    status: "",
    resourceRef: row.resource_ref,
    ackRequired: true,
    tone: row.severity,
    firstSeenAt: row.created_at,
    lastSeenAt: row.created_at,
    lifecycleStatus: row.status,
    lifecycleRevision: Number(row.lifecycle_revision || 0),
    active: !["resolved", "suppressed", "archived"].includes(row.status),
    lifecycleHistory: [],
    ...stored
  };
}

function rowToAlert(row: any = null) : any {
  if (!row) {
    return null;
  }
  const lifecycle: any = lifecycleRecordFromRow(row);
  return {
    protocolVersion: SECURITY_ALERTS_PROTOCOL_VERSION,
    alertId: row.alert_id,
    category: row.category,
    severity: row.severity,
    reasonCode: row.reason_code,
    title: row.title,
    lifecycleStatus: lifecycle.lifecycleStatus,
    lifecycleRevision: lifecycle.lifecycleRevision,
    active: lifecycle.active,
    lifecycleHistory: lifecycle.lifecycleHistory,
    actorRef: row.actor_ref,
    subjectRef: row.subject_ref,
    resourceRef: row.resource_ref,
    sourceIp: row.source_ip,
    traceId: row.trace_id,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: lifecycle.resolvedAt || "",
    suppressedAt: lifecycle.suppressedAt || "",
    notificationFailedAt: lifecycle.notificationFailedAt || "",
    archivedAt: lifecycle.archivedAt || ""
  };
}

export function createSecurityAlertStore({ userDataPath = "", db: injectedDatabase = null }: Record<string, any> = {}) : any {
  const dbPath: any = getSecurityAlertsDatabasePath(userDataPath);
  const databasePath: any = injectedDatabase ? "" : ensurePrivateSqliteLocation(dbPath);
  let db: any = injectedDatabase;
  const ownsDatabase: any = !injectedDatabase;
  try {
    if (!ownsDatabase) return createSecurityAlertStoreFromDatabase({ db, ownsDatabase, dbPath });
    return withPrivateFileCreationMask(() : any => {
      db = openSqliteDatabase(databasePath);
      const store: any = createSecurityAlertStoreFromDatabase({ db, ownsDatabase, dbPath });
      ensurePrivateSqliteLocation(databasePath);
      return store;
    });
  } catch (error: any) {
    if (ownsDatabase) {
      try {
        db.close();
      } catch {
        // Preserve the construction failure; cleanup is best effort.
      }
    }
    throw error;
  }
}

function createSecurityAlertStoreFromDatabase({ db, ownsDatabase, dbPath }: Record<string, any>) : any {
  let closed: any = false;
  ensureSchema(db);

  function writeLifecycle(alertId?: any, lifecycle?: any, {
    acknowledgedBy = "",
    retentionArchivedAt = ""
  }: Record<string, any> = {}) : any {
    const changed: any = db.prepare(`
      UPDATE security_alerts
      SET status = ?, lifecycle_revision = ?, lifecycle_json = ?,
          acknowledged_at = ?, acknowledged_by = ?, retention_archived_at = ?
      WHERE alert_id = ?
    `).run(
      lifecycle.lifecycleStatus,
      lifecycle.lifecycleRevision,
      JSON.stringify(lifecycle),
      lifecycle.acknowledgedAt || "",
      acknowledgedBy,
      retentionArchivedAt,
      alertId
    ).changes;
    return changed;
  }

  function hydrateStoredLifecycleMetadata() : any {
    const rows: any = db.prepare(`
      SELECT * FROM security_alerts
      WHERE lifecycle_json = '{}' OR lifecycle_json = ''
    `).all();
    if (rows.length === 0) return;
    const migrate: any = db.transaction(() : any => {
      for (const row of rows) {
        const createdAt: any = text(row.created_at) || nowIso();
        const signal: Record<string, any> = {
          alertId: row.alert_id,
          ruleId: row.reason_code,
          category: row.category,
          severity: alertSeverity(row.severity),
          title: row.title,
          message: row.title,
          source: "security_alert",
          role: "security",
          resourceRef: row.resource_ref || row.alert_id,
          ackRequired: true,
          tone: row.severity
        };
        const desiredStatus: any = row.status;
        if (!ALERT_LIFECYCLE_STATES.includes(desiredStatus)) {
          const error: Error & Record<string, any> = new Error("Stored security alert lifecycle status is invalid.");
          error.code = "security_alert_lifecycle_storage_invalid";
          throw error;
        }
        let lifecycle: any = desiredStatus === "rule_loaded"
          ? createAlertRecord(signal, { now: () : any => createdAt })
          : activateAlertRecord(signal, null, { actor: "migration", now: () : any => createdAt });
        if (desiredStatus === "acknowledged") {
          lifecycle = transitionAlertRecord(lifecycle, "acknowledge", { actor: "migration", now: () : any => createdAt });
        } else if (["resolved", "archived"].includes(desiredStatus)) {
          lifecycle = transitionAlertRecord(lifecycle, "resolve", { actor: "migration", now: () : any => createdAt });
        } else if (desiredStatus === "suppressed") {
          lifecycle = transitionAlertRecord(lifecycle, "suppress", { actor: "migration", now: () : any => createdAt });
        } else if (desiredStatus === "notification_failed") {
          lifecycle = transitionAlertRecord(lifecycle, "notification_failed", { actor: "migration", now: () : any => createdAt });
        }
        if (desiredStatus === "archived") {
          lifecycle = transitionAlertRecord(lifecycle, "archive", { actor: "migration", now: () : any => createdAt });
        }
        writeLifecycle(row.alert_id, lifecycle, {
          acknowledgedBy: row.acknowledged_by,
          retentionArchivedAt: row.retention_archived_at
        });
      }
    });
    migrate();
  }

  hydrateStoredLifecycleMetadata();

  function appendAlert(input: Record<string, any> = {}) : any {
    const source: any = asObject(input);
    const base: Record<string, any> = {
      alertId: text(source.alertId) || randomId("sec_alert"),
      category: text(source.category) || "security",
      severity: normalizeSeverity(source.severity || "medium"),
      reasonCode: text(source.reasonCode || source.reason_code) || "security_alert",
      title: sanitizeAlertText(source.title || "Security alert", 160),
      actorRef: stableAlertReference(source.actorRef || source.actor_ref),
      subjectRef: stableAlertReference(source.subjectRef || source.subject_ref),
      resourceRef: stableAlertReference(source.resourceRef || source.resource_ref),
      sourceIp: stableAlertReference(source.sourceIp || source.source_ip),
      traceId: stableAlertReference(source.traceId || source.trace_id),
      details: redactSecurityAlertValue(source.details || {}),
      createdAt: text(source.createdAt || source.created_at) || nowIso()
    };
    const lifecycle: any = activateAlertRecord({
      alertId: base.alertId,
      ruleId: base.reasonCode,
      category: base.category,
      severity: alertSeverity(base.severity),
      title: base.title,
      message: base.title,
      source: text(source.source) || "security_alert",
      role: "security",
      resourceRef: text(source.resourceRef || source.resource_ref) || base.alertId,
      ackRequired: true,
      tone: base.severity
    }, null, {
      actor: text(source.actorRef || source.actor_ref) || "security_producer",
      now: () : any => base.createdAt
    });
    db.prepare(`
      INSERT INTO security_alerts (
        alert_id, category, severity, reason_code, title, status, actor_ref, subject_ref,
        resource_ref, source_ip, trace_id, details_json, lifecycle_revision, lifecycle_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      base.alertId,
      base.category,
      base.severity,
      base.reasonCode,
      base.title,
      lifecycle.lifecycleStatus,
      base.actorRef,
      base.subjectRef,
      lifecycle.resourceRef,
      base.sourceIp,
      base.traceId,
      JSON.stringify(base.details),
      lifecycle.lifecycleRevision,
      JSON.stringify(lifecycle),
      base.createdAt
    );
    return getAlert(base.alertId);
  }

  function getAlert(alertId: any = "") : any {
    return rowToAlert(db.prepare("SELECT * FROM security_alerts WHERE alert_id = ?").get(text(alertId)));
  }

  function listAlerts(input: Record<string, any> = {}) : any {
    const limit: any = Math.min(1000, Math.max(1, Number(input.limit || 100) || 100));
    const where: any[] = ["retention_archived_at = ''"];
    const params: any[] = [];
    for (const [column, value] of [
      ["status", input.lifecycleStatus || input.status],
      ["severity", input.severity],
      ["reason_code", input.reasonCode || input.reason_code],
      ["category", input.category],
      ["trace_id", (input.traceId || input.trace_id) ? stableAlertReference(input.traceId || input.trace_id) : ""]
    ]) {
      const normalized: any = text(value);
      if (normalized) {
        where.push(`${column} = ?`);
        params.push(normalized);
      }
    }
    const rows: any = db.prepare(`
      SELECT * FROM security_alerts
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit);
    return rows.map(rowToAlert);
  }

  function acknowledgeAlert(input: Record<string, any> = {}) : any {
    return transitionAlert(input.alertId || input.alert_id || input.id, "acknowledge", {
      actor: input.acknowledgedBy || input.acknowledged_by || input.actorId || "operator"
    });
  }

  function transitionAlert(alertIdInput: any = "", event: any = "", input: Record<string, any> = {}) : any {
    const alertId: any = text(alertIdInput);
    if (!alertId) {
      return { ok: false, status: 400, reasonCode: "alert_id_required", error: "alertId is required." };
    }
    const row: any = db.prepare("SELECT * FROM security_alerts WHERE alert_id = ? AND retention_archived_at = ''").get(alertId);
    if (!row) {
      return { ok: false, status: 404, reasonCode: "security_alert_not_found", error: "Security alert was not found." };
    }
    const actor: any = text(input.actor || input.acknowledgedBy || input.acknowledged_by) || "operator";
    const lifecycle: any = transitionAlertRecord(lifecycleRecordFromRow(row), event, {
      actor,
      reason: input.reason,
      now: input.now,
      signal: input.signal
    });
    writeLifecycle(alertId, lifecycle, {
      acknowledgedBy: event === "acknowledge" ? actor : row.acknowledged_by,
      retentionArchivedAt: row.retention_archived_at
    });
    return { ok: true, alert: getAlert(alertId) };
  }

  function exportRedacted(input: Record<string, any> = {}) : any {
    const items: any = listAlerts(input);
    return finalizeSensitiveReport({
      protocolVersion: SECURITY_ALERTS_PROTOCOL_VERSION,
      exportedAt: nowIso(),
      itemCount: items.length,
      items,
      jsonl: items.map((item?: any) : any => JSON.stringify(item)).join("\n")
    }, {
      provenance: {
        producer: "meshrix-core-security-alerts",
        commandId: "security_alerts.export",
        sourceRevision: SECURITY_ALERTS_PROTOCOL_VERSION
      }
    });
  }

  function pruneAlerts(input: Record<string, any> = {}) : any {
    const retentionDays: any = Math.max(1, Number(input.retentionDays || input.retention_days || 90) || 90);
    const cutoff: any = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const archivedAt: any = nowIso();
    const rows: any = db.prepare(`
      SELECT * FROM security_alerts
      WHERE created_at < ? AND retention_archived_at = ''
      ORDER BY created_at ASC
      LIMIT ?
    `).all(cutoff, OBSERVABILITY_BUDGETS.maxWorkQueueDepth);
    const archiveRows: any = db.transaction(() : any => {
      for (const row of rows) {
        let lifecycle: any = lifecycleRecordFromRow(row);
        if (["firing", "acknowledged", "notification_failed"].includes(lifecycle.lifecycleStatus)) {
          lifecycle = transitionAlertRecord(lifecycle, "resolve", {
            actor: "retention",
            now: () : any => archivedAt
          });
        }
        lifecycle = transitionAlertRecord(lifecycle, "archive", {
          actor: "retention",
          now: () : any => archivedAt
        });
        writeLifecycle(row.alert_id, lifecycle, {
          acknowledgedBy: row.acknowledged_by,
          retentionArchivedAt: archivedAt
        });
      }
    });
    archiveRows();
    return {
      ok: true,
      retentionDays,
      cutoff,
      archivedAt,
      archived: rows.length,
      hasMore: rows.length === OBSERVABILITY_BUDGETS.maxWorkQueueDepth
    };
  }

  return {
    protocolVersion: SECURITY_ALERTS_PROTOCOL_VERSION,
    dbPath,
    appendAlert,
    getAlert,
    listAlerts,
    acknowledgeAlert,
    transitionAlert,
    exportRedacted,
    pruneAlerts,
    isClosed() : any {
      return closed || db.open === false;
    },
    close() : any {
      if (closed || (ownsDatabase && db.open === false)) {
        closed = true;
        return;
      }
      if (ownsDatabase) db.close();
      closed = true;
    }
  };
}
