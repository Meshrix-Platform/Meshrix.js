import type {
  AgentSettings,
  ProtocolEvent,
  ServerConsoleState,
  SplitJob,
} from "../lib/types";

export const CONSOLE_EVENT_TOPICS: readonly any[] = Object.freeze([
  "system.console_state",
  "storage.summary",
  "settings.current",
  "runtime.mounts",
  "discovery.config",
  "discovery.clients",
  "jobs.job",
  "jobs.deleted",
  "maintenance.agent.config",
  "maintenance.agent.plan.created",
  "maintenance.agent.approval.required",
  "maintenance.agent.run.started",
  "maintenance.agent.tool.started",
  "maintenance.agent.tool.completed",
  "maintenance.agent.tool.failed",
  "maintenance.agent.run.completed",
  "permissions.updated",
]);

type ObjectValue = Record<string, unknown>;

function objectValue(value: unknown): ObjectValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : null;
}

function serverConsoleStateValue(value: unknown): ServerConsoleState | null {
  const record: any = objectValue(value);
  if (
    !record ||
    !objectValue(record.server) ||
    !objectValue(record.runtime) ||
    !objectValue(record.settings) ||
    !objectValue(record.jobs) ||
    !objectValue(record.clients)
  ) return null;
  return record as unknown as ServerConsoleState;
}

export interface ConsoleEventRouterOptions {
  applyConsoleState: (state: ServerConsoleState) => void;
  applyMaintenanceConfig: (config: unknown) => boolean;
  getConsoleState: () => ServerConsoleState | null;
  refreshMaintenanceSilently: () => void;
  removeJob: (jobId: string) => boolean;
  upsertJob: (job: SplitJob) => boolean;
}

export function createConsoleEventRouter(options: ConsoleEventRouterOptions) : any {
  return function applyServerEvent(event: ProtocolEvent) : any {
    const payload: any = objectValue(event.payload) || {};
    if (event.topic === "system.console_state") {
      const state: any = serverConsoleStateValue(payload.state);
      if (!state) return false;
      options.applyConsoleState(state);
      return true;
    }
    if (event.topic === "jobs.job") {
      const job: any = objectValue(payload.job) as SplitJob | null;
      return Boolean(job?.id && options.upsertJob(job));
    }
    if (event.topic === "jobs.deleted") {
      const job: any = objectValue(payload.job) || objectValue(payload.deletedJob);
      const jobId: any = String(job?.id || payload.jobId || payload.batchId || "");
      return Boolean(jobId && options.removeJob(jobId));
    }
    if (event.topic === "settings.current") {
      const currentState: any = options.getConsoleState();
      if (!currentState) return false;
      const settings: any = objectValue(payload.value) || payload;
      options.applyConsoleState({
        ...currentState,
        settings: {
          ...currentState.settings,
          value: settings as unknown as AgentSettings,
        },
      });
      return true;
    }
    if (event.topic === "maintenance.agent.config") {
      return options.applyMaintenanceConfig(payload.config);
    }
    if (event.topic.startsWith("maintenance.agent.") && objectValue(payload.run)) {
      options.refreshMaintenanceSilently();
      return true;
    }
    return false;
  };
}
