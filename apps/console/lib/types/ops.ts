export type BackgroundProcessItem = {
  role: string;
  label: string;
  description: string;
  processType?: "service" | "daemon" | string;
  responsibility?: string;
  services?: string[];
  features?: string[];
  monitors?: string[];
  alerts?: string[];
  desired: boolean;
  pid: number;
  alive: boolean;
  stale: boolean;
  status: string;
  mode?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatAgeMs?: number | null;
  restartCount: number;
  lastExit?: Record<string, unknown> | null;
  details?: Record<string, unknown>;
  error?: string;
  unifiedRegistration?: UnifiedRegistrationRecord;
};

export type UnifiedOriginalType = "process" | "queue" | "task" | "monitor" | "alert" | string;

export type UnifiedRegistrationRecord = {
  schemaVersion: string;
  registrationId: string;
  originalType: UnifiedOriginalType;
  originalId: string;
  label: string;
  status: string;
  tone: string;
  source: string;
  registeredAt: string;
  route: {
    originalType: UnifiedOriginalType;
    section: string;
    behavior: string;
  };
  relations: Record<string, unknown>;
  attributes: Record<string, unknown>;
  originalRef: Record<string, unknown>;
};

export type UnifiedSystemStatus = {
  schemaVersion: string;
  updatedAt: string;
  source: string;
  summary: {
    totalCount: number;
    processCount: number;
    queueCount: number;
    taskCount: number;
    monitorCount: number;
    alertCount: number;
  };
  registrations: UnifiedRegistrationRecord[];
  routes: Record<string, { section: string; behavior: string }>;
  processes: UnifiedRegistrationRecord[];
  queues: UnifiedRegistrationRecord[];
  tasks: UnifiedRegistrationRecord[];
  monitors: UnifiedRegistrationRecord[];
  alerts: UnifiedRegistrationRecord[];
};

export type BackgroundProcessStatus = {
  schemaVersion: string;
  ok: boolean;
  status: string;
  updatedAt: string;
  statePath: string;
  supervisor: {
    pid: number;
    alive: boolean;
    status: string;
    startedAt?: string;
    roles?: string[];
  };
  processes: BackgroundProcessItem[];
  systemStatus?: UnifiedSystemStatus;
};

export type BackgroundSupervisorRecovery = {
  ok: boolean;
  attempted: boolean;
  action?: string;
  reason?: string;
  platform?: string;
  serviceLabel?: string;
  serviceTarget?: string;
  launchTarget?: string;
  plistPath?: string;
  checkedAt?: string;
  commands?: Array<{
    args: string[];
    code: number;
    signal?: string;
    stderr?: string;
    stdout?: string;
  }>;
};

export type BackgroundSupervisorRecoveryResponse = {
  recovery: BackgroundSupervisorRecovery;
  backgroundProcessStatus?: BackgroundProcessStatus | null;
  monitorAlertState?: MonitorAlertState | null;
};

export type MonitorAlertRule = {
  enabled: boolean;
  severity: string;
  statuses?: string[];
  restartCountThreshold?: number;
  titleTemplate: string;
  messageTemplate: string;
};

export type MonitorAlertConfig = {
  schemaVersion: string;
  enabled: boolean;
  intervalMs: number;
  heartbeatStaleMs: number;
  historyLimit: number;
  serviceLabel?: string;
  rules: Record<string, MonitorAlertRule>;
};

export type MonitorAlertItem = {
  alertId: string;
  ruleId: string;
  severity: string;
  title: string;
  message: string;
  source: string;
  role: string;
  status: string;
  active: boolean;
  ackRequired?: boolean;
  acknowledgedAt?: string;
  resourceRef?: string;
  tone?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  variables?: Record<string, unknown>;
  unifiedRegistration?: UnifiedRegistrationRecord;
};

export type WorkQueueObservationSummary = {
  observed: boolean;
  itemCount: number;
  statusCounts: Record<string, number>;
};

export type MonitorAlertState = {
  schemaVersion: string;
  ok: boolean;
  status: string;
  updatedAt: string;
  configPath: string;
  shellConfigPath?: string;
  statePath: string;
  config: MonitorAlertConfig;
  summary: {
    activeCount: number;
    visibleCount?: number;
    recoveredCount?: number;
    criticalCount: number;
    warningCount: number;
    historyCount: number;
  };
  workQueueObservation?: WorkQueueObservationSummary | null;
  acknowledgedAlerts?: Record<string, string>;
  systemStatus?: UnifiedSystemStatus;
  activeAlerts: MonitorAlertItem[];
  history: MonitorAlertItem[];
};
