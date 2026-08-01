import { computeNextRunAt, saveMaintenanceAgentConfig } from "./config.ts";
import { summarizeError } from "@meshrix/foundation/observability/runtime-logger";

export function createMaintenanceScheduler({
  userDataPath,
  schedulerEnabled,
  getConfig,
  setConfig,
  ensureStarted,
  createScheduledRun,
  publish,
  logMaintenance,
  state
}: Record<string, any>) : any {
  let schedulerTimer: any = null;
  let activeTick: any = null;

  function startScheduler() : any {
    if (!schedulerEnabled) {
      logMaintenance("info", "maintenance.agent.scheduler.skipped", {
        reason: "disabled_by_process_mode"
      });
      return;
    }
    if (!getConfig()?.enabled) {
      logMaintenance("debug", "maintenance.agent.scheduler.skipped", {
        reason: "config_disabled"
      });
      return;
    }
    if (schedulerTimer || state.closed) {
      logMaintenance("debug", "maintenance.agent.scheduler.skipped", {
        reason: schedulerTimer ? "already_running" : "closed"
      });
      return;
    }
    const config: any = getConfig();
    if (!(config?.schedules || []).some((schedule?: any) : any => schedule.enabled)) {
      logMaintenance("info", "maintenance.agent.scheduler.skipped", {
        reason: "schedules_unconfigured"
      });
      return;
    }
    const tickSeconds: any = Number(config?.scheduler?.tickSeconds || 0);
    if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
      logMaintenance("info", "maintenance.agent.scheduler.skipped", {
        reason: "scheduler_unconfigured"
      });
      return;
    }
    const tickMs: any = Math.max(1, tickSeconds) * 1000;
    schedulerTimer = setInterval(() : any => {
      void tickScheduler().catch((error?: any) : any => {
        logMaintenance("error", "maintenance.agent.scheduler.tick.failed", {
          error: summarizeError(error)
        });
      });
    }, tickMs);
    schedulerTimer.unref?.();
    logMaintenance("info", "maintenance.agent.scheduler.started", {
      tickMs
    });
  }

  async function runSchedulerTick() : Promise<any> {
    logMaintenance("debug", "maintenance.agent.scheduler.tick.started", {});
    await ensureStarted();
    let config: any = getConfig();
    if (!config.enabled || state.closed || Number(config?.scheduler?.tickSeconds || 0) <= 0) {
      logMaintenance("debug", "maintenance.agent.scheduler.tick.skipped", {
        reason: state.closed
          ? "closed"
          : !config.enabled
            ? "config_disabled"
            : "scheduler_unconfigured"
      });
      return;
    }
    const now: any = new Date();
    let changed: any = false;
    for (const schedule of config.schedules || []) {
      if (!schedule.enabled) {
        continue;
      }
      if (!schedule.nextRunAt) {
        schedule.nextRunAt = computeNextRunAt(schedule, now);
        changed = true;
        continue;
      }
      if (Date.parse(schedule.nextRunAt) > now.getTime()) {
        continue;
      }
      const occurrenceAt: any = schedule.nextRunAt;
      try {
        const run: any = await createScheduledRun({ ...schedule, occurrenceAt });
        schedule.nextRunAt = computeNextRunAt(schedule, now);
        changed = true;
        logMaintenance("info", "maintenance.agent.scheduler.run_created", {
          scheduleId: schedule.id,
          runbook: schedule.runbook,
          runId: run.runId,
          requiresApproval: run.requiresApproval,
          occurrenceAt,
          nextRunAt: schedule.nextRunAt
        });
      } catch (error: any) {
        const errorSummary: any = summarizeError(error);
        logMaintenance("error", "maintenance.agent.scheduler.run_failed", {
          scheduleId: schedule.id,
          runbook: schedule.runbook,
          occurrenceAt,
          nextRunAt: occurrenceAt,
          error: errorSummary
        });
        await publish("maintenance.agent.scheduler", {
          scheduleId: schedule.id,
          runbook: schedule.runbook,
          occurrenceAt,
          nextRunAt: occurrenceAt,
          status: "failed",
          error: errorSummary
        }, "maintenance.agent.scheduler.run_failed");
      }
    }
    if (changed) {
      config = await saveMaintenanceAgentConfig(userDataPath, config);
      setConfig(config);
      await publish("maintenance.agent.config", { config }, "maintenance.agent.config.updated");
      logMaintenance("info", "maintenance.agent.scheduler.config_saved", {
        scheduleCount: config.schedules?.length || 0
      });
    }
    logMaintenance("debug", "maintenance.agent.scheduler.tick.completed", {
      changed
    });
  }

  function tickScheduler() : any {
    if (activeTick) return activeTick;
    activeTick = runSchedulerTick().finally(() : any => {
      activeTick = null;
    });
    return activeTick;
  }

  function resetScheduler() : any {
    stopScheduler();
    if (schedulerEnabled && getConfig()?.enabled) {
      startScheduler();
    }
  }

  function stopScheduler() : any {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  return {
    startScheduler,
    tickScheduler,
    resetScheduler,
    stopScheduler
  };
}
