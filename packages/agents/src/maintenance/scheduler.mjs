import { computeNextRunAt, saveMaintenanceAgentConfig } from "./config.mjs";
import { summarizeError } from "@lico/foundation/observability/runtime-logger";

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
}) {
  let schedulerTimer = null;
  let activeTick = null;

  function startScheduler() {
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
    const config = getConfig();
    if (!(config?.schedules || []).some((schedule) => schedule.enabled)) {
      logMaintenance("info", "maintenance.agent.scheduler.skipped", {
        reason: "schedules_unconfigured"
      });
      return;
    }
    const tickSeconds = Number(config?.scheduler?.tickSeconds || 0);
    if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
      logMaintenance("info", "maintenance.agent.scheduler.skipped", {
        reason: "scheduler_unconfigured"
      });
      return;
    }
    const tickMs = Math.max(1, tickSeconds) * 1000;
    schedulerTimer = setInterval(() => {
      void tickScheduler().catch((error) => {
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

  async function runSchedulerTick() {
    logMaintenance("debug", "maintenance.agent.scheduler.tick.started", {});
    await ensureStarted();
    let config = getConfig();
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
    const now = new Date();
    let changed = false;
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
      const occurrenceAt = schedule.nextRunAt;
      try {
        const run = await createScheduledRun({ ...schedule, occurrenceAt });
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
      } catch (error) {
        const errorSummary = summarizeError(error);
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

  function tickScheduler() {
    if (activeTick) return activeTick;
    activeTick = runSchedulerTick().finally(() => {
      activeTick = null;
    });
    return activeTick;
  }

  function resetScheduler() {
    stopScheduler();
    if (schedulerEnabled && getConfig()?.enabled) {
      startScheduler();
    }
  }

  function stopScheduler() {
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
