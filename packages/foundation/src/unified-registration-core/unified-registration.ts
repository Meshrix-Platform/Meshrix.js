export const UNIFIED_REGISTRATION_SCHEMA_VERSION = "v0.0.1:platform:unified-registration-schema-1";

type UnknownRecord = Record<string, unknown>;
export type UnifiedRegistrationType = "process" | "queue" | "task" | "monitor" | "alert";
type RegistrationSection = "processes" | "queues" | "tasks" | "monitors" | "alerts";

interface RegistrationRoute {
  section: RegistrationSection;
  behavior: string;
}

export interface UnifiedSystemStatusRecord extends UnknownRecord {
  schemaVersion: typeof UNIFIED_REGISTRATION_SCHEMA_VERSION;
  registrationId: string;
  originalType: UnifiedRegistrationType;
  originalId: string;
  label: string;
  status: string;
  tone: string;
  source: string;
  registeredAt: string;
  route: RegistrationRoute & { originalType: UnifiedRegistrationType };
  relations: UnknownRecord;
  attributes: UnknownRecord;
  originalRef: UnknownRecord;
}

export const ORIGINAL_TYPES = Object.freeze({
  PROCESS: "process",
  QUEUE: "queue",
  TASK: "task",
  MONITOR: "monitor",
  ALERT: "alert"
});

export const UNIFIED_REGISTRATION_ROUTES: Readonly<Record<UnifiedRegistrationType, RegistrationRoute>> = Object.freeze({
  [ORIGINAL_TYPES.PROCESS]: {
    section: "processes",
    behavior: "render_process_status"
  },
  [ORIGINAL_TYPES.QUEUE]: {
    section: "queues",
    behavior: "render_queue_status"
  },
  [ORIGINAL_TYPES.TASK]: {
    section: "tasks",
    behavior: "render_task_status"
  },
  [ORIGINAL_TYPES.MONITOR]: {
    section: "monitors",
    behavior: "render_monitor_status"
  },
  [ORIGINAL_TYPES.ALERT]: {
    section: "alerts",
    behavior: "render_alert_status"
  }
});

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value?: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringArray(value?: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function firstString(value: unknown): string {
  return Array.isArray(value) ? String(value[0] || "") : "";
}

function normalizeStatusTone(type: UnifiedRegistrationType, status: unknown, extra: UnknownRecord = {}): string {
  const normalized = String(status || "").toLowerCase();
  if (type === ORIGINAL_TYPES.ALERT) {
    if (extra.ackRequired || normalized === "recovered") {
      return "success";
    }
    return extra.severity === "critical" ? "danger" : extra.severity === "warning" ? "warning" : "info";
  }
  if (["interrupted", "failed", "missing", "stopped", "stale", "degraded", "exited"].includes(normalized)) {
    return normalized === "stale" || normalized === "degraded" ? "warning" : "danger";
  }
  if (["completed", "closed", "recovered", "healthy", "running"].includes(normalized)) {
    return normalized === "running" ? "running" : "success";
  }
  if (["queued", "awaiting_approval", "standby", "starting"].includes(normalized)) {
    return "queued";
  }
  return "neutral";
}

export class UnifiedRegistration {
  getOriginalType(): UnifiedRegistrationType {
    throw new Error("UnifiedRegistration.getOriginalType must be implemented.");
  }

  getOriginalId(): string {
    throw new Error("UnifiedRegistration.getOriginalId must be implemented.");
  }

  getLabel(): string {
    return this.getOriginalId();
  }

  getStatus(): string {
    return "unknown";
  }

  getSource(): string {
    return "";
  }

  getRegisteredAt(): string {
    return nowIso();
  }

  getRelations(): UnknownRecord {
    return {};
  }

  getAttributes(): UnknownRecord {
    return {};
  }

  getOriginalRef(): UnknownRecord {
    return {};
  }

  toSystemStatusRecord(): UnifiedSystemStatusRecord {
    const originalType = this.getOriginalType();
    const route = routeUnifiedRegistration(this);
    const status = String(this.getStatus() || "unknown");
    return {
      schemaVersion: UNIFIED_REGISTRATION_SCHEMA_VERSION,
      registrationId: `${originalType}:${this.getOriginalId()}`,
      originalType,
      originalId: this.getOriginalId(),
      label: this.getLabel(),
      status,
      tone: normalizeStatusTone(originalType, status, this.getAttributes()),
      source: this.getSource(),
      registeredAt: this.getRegisteredAt(),
      route,
      relations: this.getRelations(),
      attributes: this.getAttributes(),
      originalRef: this.getOriginalRef()
    };
  }
}

export class ProcessUnifiedRegistration extends UnifiedRegistration {
  processItem: UnknownRecord;
  constructor(processItem: UnknownRecord = {}) {
    super();
    this.processItem = asObject(processItem);
  }

  getOriginalType(): UnifiedRegistrationType {
    return ORIGINAL_TYPES.PROCESS;
  }

  getOriginalId(): string {
    return String(this.processItem.role || "unknown-process");
  }

  getLabel(): string {
    return String(this.processItem.label || this.processItem.role || "unknown-process");
  }

  getStatus(): string {
    return String(this.processItem.status || "unknown");
  }

  getSource(): string {
    return String(this.processItem.processType || "service");
  }

  getRegisteredAt(): string {
    return String(this.processItem.lastHeartbeatAt || this.processItem.startedAt || nowIso());
  }

  getRelations(): UnknownRecord {
    return {
      features: stringArray(this.processItem.features),
      services: stringArray(this.processItem.services),
      monitors: stringArray(this.processItem.monitors),
      alerts: stringArray(this.processItem.alerts)
    };
  }

  getAttributes(): UnknownRecord {
    return {
      role: this.getOriginalId(),
      processType: String(this.processItem.processType || "service"),
      pid: Number(this.processItem.pid || 0),
      alive: this.processItem.alive === true,
      stale: this.processItem.stale === true,
      desired: this.processItem.desired !== false,
      restartCount: Number(this.processItem.restartCount || 0),
      heartbeatAgeMs: this.processItem.heartbeatAgeMs ?? null,
      mode: String(this.processItem.mode || ""),
      responsibility: String(this.processItem.responsibility || this.processItem.description || "")
    };
  }

  getOriginalRef(): UnknownRecord {
    return {
      role: this.getOriginalId(),
      pid: Number(this.processItem.pid || 0)
    };
  }
}

export class QueueUnifiedRegistration extends UnifiedRegistration {
  queueItem: UnknownRecord;
  constructor(queueItem: UnknownRecord = {}) {
    super();
    this.queueItem = asObject(queueItem);
  }

  getOriginalType(): UnifiedRegistrationType {
    return ORIGINAL_TYPES.QUEUE;
  }

  getOriginalId(): string {
    return String(this.queueItem.queueId || "unknown-queue");
  }

  getLabel(): string {
    return String(this.queueItem.label || this.queueItem.queueId || "unknown-queue");
  }

  getStatus(): string {
    return String(this.queueItem.lifecycleStatus || this.queueItem.status || "unknown");
  }

  getSource(): string {
    return String(this.queueItem.source || firstString(this.queueItem.sources) || "work-queue-observation");
  }

  getRegisteredAt(): string {
    return String(
      this.queueItem.lastHeartbeatAt ||
        this.queueItem.closedAt ||
        this.queueItem.recoveredAt ||
        this.queueItem.startedAt ||
        nowIso()
    );
  }

  getRelations(): UnknownRecord {
    return {
      ownerId: String(this.queueItem.ownerId || ""),
      checkpointId: String(this.queueItem.checkpointId || ""),
      checkpointTreeId: String(this.queueItem.checkpointTreeId || ""),
      sources: stringArray(this.queueItem.sources)
    };
  }

  getAttributes(): UnknownRecord {
    return {
      queueId: this.getOriginalId(),
      kind: String(this.queueItem.kind || "queue"),
      phase: String(this.queueItem.phase || ""),
      status: String(this.queueItem.status || ""),
      lifecycleStatus: this.getStatus(),
      startedAt: String(this.queueItem.startedAt || ""),
      closedAt: String(this.queueItem.closedAt || ""),
      lastHeartbeatAt: String(this.queueItem.lastHeartbeatAt || ""),
      interruptedAt: String(this.queueItem.interruptedAt || ""),
      recoveredAt: String(this.queueItem.recoveredAt || ""),
      recoveryStatus: String(this.queueItem.recoveryStatus || ""),
      interruptedReason: String(this.queueItem.interruptedReason || "")
    };
  }

  getOriginalRef(): UnknownRecord {
    return {
      queueId: this.getOriginalId(),
      ownerId: String(this.queueItem.ownerId || ""),
      kind: String(this.queueItem.kind || "queue")
    };
  }
}

export class TaskUnifiedRegistration extends UnifiedRegistration {
  options: UnknownRecord;
  taskItem: UnknownRecord;
  constructor(taskItem: UnknownRecord = {}, options: UnknownRecord = {}) {
    super();
    this.taskItem = asObject(taskItem);
    this.options = asObject(options);
  }

  getOriginalType(): UnifiedRegistrationType {
    return ORIGINAL_TYPES.TASK;
  }

  getOriginalId(): string {
    return String(this.options.taskId || this.taskItem.id || this.taskItem.runId || "unknown-task");
  }

  getLabel(): string {
    return String(
      this.options.label ||
        this.taskItem.summary ||
        this.taskItem.stage ||
        this.taskItem.intent ||
        this.getOriginalId()
    );
  }

  getStatus(): string {
    return String(this.taskItem.status || "unknown");
  }

  getSource(): string {
    return String(this.options.source || this.taskItem.source || "task");
  }

  getRegisteredAt(): string {
    return String(this.taskItem.updatedAt || this.taskItem.startedAt || this.taskItem.createdAt || nowIso());
  }

  getRelations(): UnknownRecord {
    return {
      queueId: String(this.options.queueId || this.taskItem.queueId || ""),
      checkpointId: String(this.taskItem.checkpointId || ""),
      checkpointTreeId: String(this.taskItem.checkpointTreeId || ""),
      feature: String(this.options.feature || "")
    };
  }

  getAttributes(): UnknownRecord {
    return {
      taskType: String(this.options.taskType || this.taskItem.taskType || "task"),
      progressPercent: Number(this.taskItem.progressPercent || 0),
      stage: String(this.taskItem.stage || this.taskItem.intent || this.taskItem.summary || ""),
      createdAt: String(this.taskItem.createdAt || ""),
      updatedAt: String(this.taskItem.updatedAt || ""),
      startedAt: String(this.taskItem.startedAt || ""),
      finishedAt: String(this.taskItem.finishedAt || this.taskItem.completedAt || ""),
      risk: String(this.taskItem.risk || "")
    };
  }

  getOriginalRef(): UnknownRecord {
    return {
      taskId: this.getOriginalId(),
      taskType: String(this.options.taskType || this.taskItem.taskType || "task")
    };
  }
}

export class MonitorUnifiedRegistration extends UnifiedRegistration {
  monitorItem: UnknownRecord;
  constructor(monitorItem: UnknownRecord = {}) {
    super();
    this.monitorItem = asObject(monitorItem);
  }

  getOriginalType(): UnifiedRegistrationType {
    return ORIGINAL_TYPES.MONITOR;
  }

  getOriginalId(): string {
    return String(this.monitorItem.monitorId || this.monitorItem.id || "system-monitor");
  }

  getLabel(): string {
    return String(this.monitorItem.label || this.getOriginalId());
  }

  getStatus(): string {
    return String(this.monitorItem.status || "unknown");
  }

  getSource(): string {
    return String(this.monitorItem.source || "system-status");
  }

  getRegisteredAt(): string {
    return String(this.monitorItem.updatedAt || nowIso());
  }

  getRelations(): UnknownRecord {
    return {
      features: stringArray(this.monitorItem.features),
      monitors: stringArray(this.monitorItem.monitors),
      alerts: stringArray(this.monitorItem.alerts)
    };
  }

  getAttributes(): UnknownRecord {
    return {
      ok: this.monitorItem.ok !== false,
      summary: asObject(this.monitorItem.summary),
      statePath: String(this.monitorItem.statePath || ""),
      configPath: String(this.monitorItem.configPath || "")
    };
  }

  getOriginalRef(): UnknownRecord {
    return {
      monitorId: this.getOriginalId()
    };
  }
}

export class AlertUnifiedRegistration extends UnifiedRegistration {
  alertItem: UnknownRecord;
  constructor(alertItem: UnknownRecord = {}) {
    super();
    this.alertItem = asObject(alertItem);
  }

  getOriginalType(): UnifiedRegistrationType {
    return ORIGINAL_TYPES.ALERT;
  }

  getOriginalId(): string {
    return String(this.alertItem.alertId || "unknown-alert");
  }

  getLabel(): string {
    return String(this.alertItem.title || this.alertItem.alertId || "unknown-alert");
  }

  getStatus(): string {
    return this.alertItem.ackRequired || this.alertItem.active === false
      ? "recovered"
      : String(this.alertItem.status || this.alertItem.severity || "unknown");
  }

  getSource(): string {
    return String(this.alertItem.source || "monitor-alerts");
  }

  getRegisteredAt(): string {
    return String(this.alertItem.lastSeenAt || this.alertItem.firstSeenAt || nowIso());
  }

  getRelations(): UnknownRecord {
    return {
      role: String(this.alertItem.role || ""),
      queueId: String(this.alertItem.queueId || ""),
      ruleId: String(this.alertItem.ruleId || "")
    };
  }

  getAttributes(): UnknownRecord {
    return {
      severity: String(this.alertItem.severity || ""),
      ruleId: String(this.alertItem.ruleId || ""),
      message: String(this.alertItem.message || ""),
      active: this.alertItem.active !== false,
      ackRequired: this.alertItem.ackRequired === true,
      acknowledgedAt: String(this.alertItem.acknowledgedAt || ""),
      interruptedAt: String(this.alertItem.interruptedAt || ""),
      recoveredAt: String(this.alertItem.recoveredAt || "")
    };
  }

  getOriginalRef(): UnknownRecord {
    return {
      alertId: this.getOriginalId(),
      ruleId: String(this.alertItem.ruleId || "")
    };
  }
}

export function routeUnifiedRegistration(registration: UnifiedRegistration | UnknownRecord): RegistrationRoute & { originalType: UnifiedRegistrationType } {
  const originalType =
    registration instanceof UnifiedRegistration
      ? registration.getOriginalType()
      : String(registration.originalType || "") as UnifiedRegistrationType;
  const route = UNIFIED_REGISTRATION_ROUTES[originalType];
  if (!route) {
    throw new Error(`Unsupported unified registration type: ${originalType || "unknown"}`);
  }
  return {
    originalType,
    ...route
  };
}

export function normalizeUnifiedRegistration(registration?: unknown): UnifiedSystemStatusRecord {
  if (registration instanceof UnifiedRegistration) {
    return registration.toSystemStatusRecord();
  }
  const record = asObject(registration);
  if (!record.registrationId || !record.originalType) {
    throw new Error("Invalid unified registration record.");
  }
  const route = asObject(record.route).section
    ? asObject(record.route) as unknown as RegistrationRoute & { originalType: UnifiedRegistrationType }
    : routeUnifiedRegistration(record);
  return {
    schemaVersion: UNIFIED_REGISTRATION_SCHEMA_VERSION,
    registrationId: String(record.registrationId),
    originalType: String(record.originalType) as UnifiedRegistrationType,
    originalId: String(record.originalId || ""),
    label: String(record.label || record.originalId || ""),
    status: String(record.status || "unknown"),
    tone: String(record.tone || "neutral"),
    source: String(record.source || ""),
    registeredAt: String(record.registeredAt || nowIso()),
    relations: asObject(record.relations),
    attributes: asObject(record.attributes),
    originalRef: asObject(record.originalRef),
    ...record,
    route,
  };
}

export function unifiedRegistrationForProcess(processItem?: unknown): UnifiedSystemStatusRecord {
  return new ProcessUnifiedRegistration(asObject(processItem)).toSystemStatusRecord();
}

export function unifiedRegistrationForQueue(queueItem?: unknown): UnifiedSystemStatusRecord {
  return new QueueUnifiedRegistration(asObject(queueItem)).toSystemStatusRecord();
}

export function unifiedRegistrationForTask(taskItem?: unknown, options: UnknownRecord = {}): UnifiedSystemStatusRecord {
  return new TaskUnifiedRegistration(asObject(taskItem), options).toSystemStatusRecord();
}

export function unifiedRegistrationForMonitor(monitorItem?: unknown): UnifiedSystemStatusRecord {
  return new MonitorUnifiedRegistration(asObject(monitorItem)).toSystemStatusRecord();
}

export function unifiedRegistrationForAlert(alertItem?: unknown): UnifiedSystemStatusRecord {
  return new AlertUnifiedRegistration(asObject(alertItem)).toSystemStatusRecord();
}

export function composeUnifiedSystemStatus(registrations: readonly unknown[] = [], options: UnknownRecord = {}) {
  const normalized = registrations
    .filter(Boolean)
    .map((item) => normalizeUnifiedRegistration(item));
  const buckets: Record<RegistrationSection, UnifiedSystemStatusRecord[]> = {
    processes: [],
    queues: [],
    tasks: [],
    monitors: [],
    alerts: []
  };
  for (const registration of normalized) {
    const section = registration.route.section;
    buckets[section].push(registration);
  }
  return {
    schemaVersion: UNIFIED_REGISTRATION_SCHEMA_VERSION,
    updatedAt: options.updatedAt || nowIso(),
    source: options.source || "system-status",
    summary: {
      totalCount: normalized.length,
      processCount: buckets.processes.length,
      queueCount: buckets.queues.length,
      taskCount: buckets.tasks.length,
      monitorCount: buckets.monitors.length,
      alertCount: buckets.alerts.length
    },
    registrations: normalized,
    routes: UNIFIED_REGISTRATION_ROUTES,
    ...buckets
  };
}
