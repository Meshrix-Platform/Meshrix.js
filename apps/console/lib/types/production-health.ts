export type ProductionHealthGateStatus = "pass" | "fail" | "timeout" | "blocked" | "missing" | "partial" | "warning" | "unknown" | string;

export type ProductionHealthGate = {
  id: string;
  title: string;
  status: ProductionHealthGateStatus;
  tone: string;
  blockerLevel: string;
  owner: string;
  coverage: string[];
  evidencePath: string;
  nextStep: string;
  commandSummary: {
    total: number;
    failed: number;
    timedOut: number;
    elapsedMs: number;
  };
  commands: Array<{
    command: string;
    exitCode: number;
    timedOut: boolean;
    elapsedMs: number;
  }>;
};

export type ProductionHealthSection = {
  id: string;
  label: string;
  description: string;
  gateIds: string[];
  status: ProductionHealthGateStatus;
  tone: string;
  passed: number;
  total: number;
  missingGateIds: string[];
  gates: Array<{
    id: string;
    title: string;
    status: ProductionHealthGateStatus;
    tone: string;
    blockerLevel: string;
    nextStep: string;
    evidencePath: string;
  }>;
  nextSteps: string[];
};

export type ProductionHealthResponse = {
  schemaVersion: string;
  reportType: "v0.0.1:platform:production-health-1" | string;
  generatedAt: string;
  status: ProductionHealthGateStatus;
  tone: string;
  reportRoot: string;
  latestReport: null | {
    reportType: string;
    runId: string;
    generatedAt: string;
    mode: string;
    reportPath: string;
    markdownPath: string;
    readError?: string;
    overallStatus: string;
    productionClaimAllowed: boolean;
    releaseClaim: string;
    git: {
      branch: string;
      commit: string;
      dirtyFileCount: number;
    };
  };
  summary: {
    pass: number;
    fail: number;
    timeout: number;
    blockedP0: number;
  };
  coverage: {
    required: string[];
    missing: string[];
  };
  capabilityKernel?: {
    ok: boolean;
    protocolVersion: string;
    status: string;
    tone: string;
    alias: string;
    provider: string;
    configuredBackend: string;
    securityMode: string;
    degraded: boolean;
    runtimeLookupLoaded: boolean;
    runtimeLookupGeneration: number;
    bindingCount: number;
    permissionBindingCount: number;
    stateRoot: string;
    statePath: string;
    linuxDetectedBackends: string[];
    recoverySupported: boolean;
    message: string;
  } | null;
  capabilityBindingGuard?: {
    ok: boolean;
    protocolVersion: string;
    status: string;
    tone: string;
    alias: string;
    provider: string;
    configuredBackend: string;
    securityMode: string;
    degraded: boolean;
    bindingCount: number;
    activeBindingCount: number;
    stateRoot: string;
    statePath: string;
    message: string;
  } | null;
  sections: ProductionHealthSection[];
  gates: ProductionHealthGate[];
  history?: Array<{
    runId: string;
    generatedAt: string;
    status: ProductionHealthGateStatus;
    mode: string;
    reportPath: string;
  }>;
  actions: Array<{
    id: string;
    label: string;
    command: string;
  }>;
};

export type ReadinessBaselinePortSummary = {
  port: string;
  implementation: string;
  verificationMode?: string;
  recordCount?: number;
  entryCount?: number;
  taskCount?: number;
  queuedCount?: number;
  artifactCount?: number;
  secretRefCount?: number;
  counts?: Record<string, number>;
};

export type ReadinessBaselineStatus = {
  schemaVersion: string;
  protocolVersion: string;
  status: string;
  verificationMode: string;
  readiness: {
    status: "not-assessed";
    authority: "platform-acceptance-reducer";
  };
  boundaries: Record<string, string>;
  mcpOutlets: string[];
  storageStates: string[];
  ports: ReadinessBaselinePortSummary[];
};
