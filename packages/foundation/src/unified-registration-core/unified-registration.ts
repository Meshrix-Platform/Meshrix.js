export const UNIFIED_REGISTRATION_SCHEMA_VERSION: any = "v0.0.1:platform:unified-registration-schema-1";

export const ORIGINAL_TYPES: Readonly<Record<string, any>> = Object.freeze({
  PROCESS: "process",
  QUEUE: "queue",
  TASK: "task",
  MONITOR: "monitor",
  ALERT: "alert"
});

export const UNIFIED_REGISTRATION_ROUTES: Readonly<Record<string, any>> = Object.freeze({
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

function nowIso() : any {
  return new Date().toISOString();
}

function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value?: any) : any {
  return Array.isArray(value)
    ? value.map((item?: any) : any => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeStatusTone(type?: any, status?: any, extra: Record<string, any> = {}) : any {
  const normalized: any = String(status || "").toLowerCase();
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
  getOriginalType() : any {
    throw new Error("UnifiedRegistration.getOriginalType must be implemented.");
  }

  getOriginalId() : any {
    throw new Error("UnifiedRegistration.getOriginalId must be implemented.");
  }

  getLabel() : any {
    return this.getOriginalId();
  }

  getStatus() : any {
    return "unknown";
  }

  getSource() : any {
    return "";
  }

  getRegisteredAt() : any {
    return nowIso();
  }

  getRelations() : any {
    return {};
  }

  getAttributes() : any {
    return {};
  }

  getOriginalRef() : any {
    return {};
  }

  toSystemStatusRecord() : any {
    const originalType: any = this.getOriginalType();
    const route: any = routeUnifiedRegistration(this);
    const status: any = String(this.getStatus() || "unknown");
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
  processItem: any;
  constructor(processItem: Record<string, any> = {}) {
    super();
    this.processItem = asObject(processItem);
  }

  getOriginalType() : any {
    return ORIGINAL_TYPES.PROCESS;
  }

  getOriginalId() : any {
    return String(this.processItem.role || "unknown-process");
  }

  getLabel() : any {
    return String(this.processItem.label || this.processItem.role || "unknown-process");
  }

  getStatus() : any {
    return String(this.processItem.status || "unknown");
  }

  getSource() : any {
    return String(this.processItem.processType || "service");
  }

  getRegisteredAt() : any {
    return String(this.processItem.lastHeartbeatAt || this.processItem.startedAt || nowIso());
  }

  getRelations() : any {
    return {
      features: stringArray(this.processItem.features),
      services: stringArray(this.processItem.services),
      monitors: stringArray(this.processItem.monitors),
      alerts: stringArray(this.processItem.alerts)
    };
  }

  getAttributes() : any {
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

  getOriginalRef() : any {
    return {
      role: this.getOriginalId(),
      pid: Number(this.processItem.pid || 0)
    };
  }
}

export class QueueUnifiedRegistration extends UnifiedRegistration {
  queueItem: any;
  constructor(queueItem: Record<string, any> = {}) {
    super();
    this.queueItem = asObject(queueItem);
  }

  getOriginalType() : any {
    return ORIGINAL_TYPES.QUEUE;
  }

  getOriginalId() : any {
    return String(this.queueItem.queueId || "unknown-queue");
  }

  getLabel() : any {
    return String(this.queueItem.label || this.queueItem.queueId || "unknown-queue");
  }

  getStatus() : any {
    return String(this.queueItem.lifecycleStatus || this.queueItem.status || "unknown");
  }

  getSource() : any {
    return String(this.queueItem.source || this.queueItem.sources?.[0] || "work-queue-observation");
  }

  getRegisteredAt() : any {
    return String(
      this.queueItem.lastHeartbeatAt ||
        this.queueItem.closedAt ||
        this.queueItem.recoveredAt ||
        this.queueItem.startedAt ||
        nowIso()
    );
  }

  getRelations() : any {
    return {
      ownerId: String(this.queueItem.ownerId || ""),
      checkpointId: String(this.queueItem.checkpointId || ""),
      checkpointTreeId: String(this.queueItem.checkpointTreeId || ""),
      sources: stringArray(this.queueItem.sources)
    };
  }

  getAttributes() : any {
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

  getOriginalRef() : any {
    return {
      queueId: this.getOriginalId(),
      ownerId: String(this.queueItem.ownerId || ""),
      kind: String(this.queueItem.kind || "queue")
    };
  }
}

export class TaskUnifiedRegistration extends UnifiedRegistration {
  options: any;
  taskItem: any;
  constructor(taskItem: Record<string, any> = {}, options: Record<string, any> = {}) {
    super();
    this.taskItem = asObject(taskItem);
    this.options = asObject(options);
  }

  getOriginalType() : any {
    return ORIGINAL_TYPES.TASK;
  }

  getOriginalId() : any {
    return String(this.options.taskId || this.taskItem.id || this.taskItem.runId || "unknown-task");
  }

  getLabel() : any {
    return String(
      this.options.label ||
        this.taskItem.summary ||
        this.taskItem.stage ||
        this.taskItem.intent ||
        this.getOriginalId()
    );
  }

  getStatus() : any {
    return String(this.taskItem.status || "unknown");
  }

  getSource() : any {
    return String(this.options.source || this.taskItem.source || "task");
  }

  getRegisteredAt() : any {
    return String(this.taskItem.updatedAt || this.taskItem.startedAt || this.taskItem.createdAt || nowIso());
  }

  getRelations() : any {
    return {
      queueId: String(this.options.queueId || this.taskItem.queueId || ""),
      checkpointId: String(this.taskItem.checkpointId || ""),
      checkpointTreeId: String(this.taskItem.checkpointTreeId || ""),
      feature: String(this.options.feature || "")
    };
  }

  getAttributes() : any {
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

  getOriginalRef() : any {
    return {
      taskId: this.getOriginalId(),
      taskType: String(this.options.taskType || this.taskItem.taskType || "task")
    };
  }
}

export class MonitorUnifiedRegistration extends UnifiedRegistration {
  monitorItem: any;
  constructor(monitorItem: Record<string, any> = {}) {
    super();
    this.monitorItem = asObject(monitorItem);
  }

  getOriginalType() : any {
    return ORIGINAL_TYPES.MONITOR;
  }

  getOriginalId() : any {
    return String(this.monitorItem.monitorId || this.monitorItem.id || "system-monitor");
  }

  getLabel() : any {
    return String(this.monitorItem.label || this.getOriginalId());
  }

  getStatus() : any {
    return String(this.monitorItem.status || "unknown");
  }

  getSource() : any {
    return String(this.monitorItem.source || "system-status");
  }

  getRegisteredAt() : any {
    return String(this.monitorItem.updatedAt || nowIso());
  }

  getRelations() : any {
    return {
      features: stringArray(this.monitorItem.features),
      monitors: stringArray(this.monitorItem.monitors),
      alerts: stringArray(this.monitorItem.alerts)
    };
  }

  getAttributes() : any {
    return {
      ok: this.monitorItem.ok !== false,
      summary: asObject(this.monitorItem.summary),
      statePath: String(this.monitorItem.statePath || ""),
      configPath: String(this.monitorItem.configPath || "")
    };
  }

  getOriginalRef() : any {
    return {
      monitorId: this.getOriginalId()
    };
  }
}

export class AlertUnifiedRegistration extends UnifiedRegistration {
  alertItem: any;
  constructor(alertItem: Record<string, any> = {}) {
    super();
    this.alertItem = asObject(alertItem);
  }

  getOriginalType() : any {
    return ORIGINAL_TYPES.ALERT;
  }

  getOriginalId() : any {
    return String(this.alertItem.alertId || "unknown-alert");
  }

  getLabel() : any {
    return String(this.alertItem.title || this.alertItem.alertId || "unknown-alert");
  }

  getStatus() : any {
    return this.alertItem.ackRequired || this.alertItem.active === false
      ? "recovered"
      : String(this.alertItem.status || this.alertItem.severity || "unknown");
  }

  getSource() : any {
    return String(this.alertItem.source || "monitor-alerts");
  }

  getRegisteredAt() : any {
    return String(this.alertItem.lastSeenAt || this.alertItem.firstSeenAt || nowIso());
  }

  getRelations() : any {
    return {
      role: String(this.alertItem.role || ""),
      queueId: String(this.alertItem.queueId || ""),
      ruleId: String(this.alertItem.ruleId || "")
    };
  }

  getAttributes() : any {
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

  getOriginalRef() : any {
    return {
      alertId: this.getOriginalId(),
      ruleId: String(this.alertItem.ruleId || "")
    };
  }
}

export function routeUnifiedRegistration(registration?: any) : any {
  const originalType: any =
    registration instanceof UnifiedRegistration
      ? registration.getOriginalType()
      : String(registration?.originalType || "");
  const route: any = UNIFIED_REGISTRATION_ROUTES[originalType];
  if (!route) {
    throw new Error(`Unsupported unified registration type: ${originalType || "unknown"}`);
  }
  return {
    originalType,
    ...route
  };
}

export function normalizeUnifiedRegistration(registration?: any) : any {
  if (registration instanceof UnifiedRegistration) {
    return registration.toSystemStatusRecord();
  }
  const record: any = asObject(registration);
  if (!record.registrationId || !record.originalType) {
    throw new Error("Invalid unified registration record.");
  }
  const route: any = record.route || routeUnifiedRegistration(record);
  return {
    schemaVersion: UNIFIED_REGISTRATION_SCHEMA_VERSION,
    ...record,
    route
  };
}

export function unifiedRegistrationForProcess(processItem?: any) : any {
  return new ProcessUnifiedRegistration(processItem).toSystemStatusRecord();
}

export function unifiedRegistrationForQueue(queueItem?: any) : any {
  return new QueueUnifiedRegistration(queueItem).toSystemStatusRecord();
}

export function unifiedRegistrationForTask(taskItem?: any, options: Record<string, any> = {}) : any {
  return new TaskUnifiedRegistration(taskItem, options).toSystemStatusRecord();
}

export function unifiedRegistrationForMonitor(monitorItem?: any) : any {
  return new MonitorUnifiedRegistration(monitorItem).toSystemStatusRecord();
}

export function unifiedRegistrationForAlert(alertItem?: any) : any {
  return new AlertUnifiedRegistration(alertItem).toSystemStatusRecord();
}

export function composeUnifiedSystemStatus(registrations: any = [], options: Record<string, any> = {}) : any {
  const normalized: any = registrations
    .filter(Boolean)
    .map((item?: any) : any => normalizeUnifiedRegistration(item));
  const buckets: Record<string, any> = {
    processes: [],
    queues: [],
    tasks: [],
    monitors: [],
    alerts: []
  };
  for (const registration of normalized) {
    const section: any = registration.route?.section;
    if (!buckets[section]) {
      continue;
    }
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
