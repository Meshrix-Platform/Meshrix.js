import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const getBackgroundProcessStatusMock: any = vi.hoisted(() : any => vi.fn());
const setBackgroundProcessDepsMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../packages/foundation/src/observability/background-process-status.ts", () : any => ({
  getBackgroundProcessStatus: getBackgroundProcessStatusMock,
  setBackgroundProcessDeps: setBackgroundProcessDepsMock
}));

import {
  acknowledgeMonitorAlert,
  getMonitorAlertState,
  loadMonitorAlertConfig,
  monitorAlertConfigPath,
  monitorAlertShellConfigPath,
  monitorAlertStatePath,
  runMonitorAlertCycle,
  saveMonitorAlertConfig,
  transitionMonitorAlertLifecycle
} from "../../../packages/server-runtime/src/composition/devops/monitor-alerts.ts";
import { OBSERVABILITY_BUDGETS } from "../../../packages/foundation/src/observability/observability-budgets.ts";

const tempRoots: any[] = [];

beforeEach(() : any => {
  getBackgroundProcessStatusMock.mockReset();
  setBackgroundProcessDepsMock.mockReset();
  getBackgroundProcessStatusMock.mockResolvedValue({ supervisor: { alive: true }, processes: [] });
});

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { force: true, recursive: true })));
});

async function withTempUserData(handler?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-observability-alert-"));
  tempRoots.push(userDataPath);
  await handler(userDataPath);
}

async function configureProcessAlert(userDataPath?: any) : Promise<any> {
  return saveMonitorAlertConfig(userDataPath, {
    enabled: true,
    intervalMs: 2_000,
    historyLimit: 20,
    rules: {
      processNotRunning: {
        enabled: true,
        severity: "critical",
        statuses: ["missing"]
      }
    }
  });
}

function processStatus(status: any = "missing", role: any = "agent-worker") : any {
  return {
    supervisor: { alive: true },
    processes: [{ role, status, desired: true, restartCount: 0 }]
  };
}

describe("monitor alert canonical runtime", () : any => {
  it("keeps missing and empty user configuration unconfigured", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      expect(await loadMonitorAlertConfig(userDataPath)).toEqual({
        schemaVersion: "v0.0.1:schema:definition-1",
        configurationState: "unconfigured",
        rules: {}
      });

      const saved: any = await saveMonitorAlertConfig(userDataPath, {});
      expect(saved.configurationState).toBe("unconfigured");
      await expect(fs.stat(monitorAlertConfigPath(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(monitorAlertShellConfigPath(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });

      const state: any = await runMonitorAlertCycle(userDataPath);
      expect(state).toMatchObject({ ok: true, status: "unconfigured", reason: "configuration_missing" });
      expect(state.metrics).toMatchObject({ seriesCount: 1, maxSeries: 16 });
      expect(state.config).toEqual({
        schemaVersion: "v0.0.1:schema:definition-1",
        configurationState: "unconfigured",
        rules: {}
      });
      expect(state.activeAlerts).toEqual([]);
    });
  });

  it("persists only explicit configuration and rejects inferred or malformed values", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const configured: any = await configureProcessAlert(userDataPath);
      expect(configured).toEqual({
        schemaVersion: "v0.0.1:schema:definition-1",
        configurationState: "configured",
        enabled: true,
        intervalMs: 2_000,
        historyLimit: 20,
        rules: {
          processNotRunning: {
            enabled: true,
            severity: "critical",
            statuses: ["missing"]
          }
        }
      });
      const persisted: any = JSON.parse(await fs.readFile(monitorAlertConfigPath(userDataPath), "utf8"));
      expect(persisted.configurationState).toBeUndefined();
      expect(persisted.rules.supervisorStopped).toBeUndefined();
      expect(await fs.readFile(monitorAlertShellConfigPath(userDataPath), "utf8"))
        .toContain("PROCESS_NOT_RUNNING_ENABLED=1");

      await expect(saveMonitorAlertConfig(userDataPath, { enabled: "true" }))
        .rejects.toMatchObject({ code: "observability_config_boolean_invalid" });
      await expect(saveMonitorAlertConfig(userDataPath, { unknown: true }))
        .rejects.toMatchObject({ code: "observability_config_unknown_field" });
    });
  });

  it("uses alert.lifecycle for firing acknowledgement resolution and archive", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      await configureProcessAlert(userDataPath);
      getBackgroundProcessStatusMock.mockResolvedValue(processStatus("missing"));

      const firing: any = await runMonitorAlertCycle(userDataPath);
      expect(firing.metrics.series).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dimensions: expect.objectContaining({ family: "monitor_active_alerts", status: "firing" }),
          count: 1
        })
      ]));
      const alert: any = firing.activeAlerts[0];
      expect(alert).toMatchObject({ lifecycleStatus: "firing", lifecycleRevision: 1, active: true });

      const acknowledged: any = await acknowledgeMonitorAlert(userDataPath, alert.alertId);
      expect(acknowledged.activeAlerts[0]).toMatchObject({
        lifecycleStatus: "acknowledged",
        lifecycleRevision: 2,
        active: true
      });

      const repeated: any = await runMonitorAlertCycle(userDataPath);
      expect(repeated.activeAlerts[0].lifecycleStatus).toBe("acknowledged");

      getBackgroundProcessStatusMock.mockResolvedValue(processStatus("running"));
      const resolved: any = await runMonitorAlertCycle(userDataPath);
      expect(resolved.activeAlerts).toEqual([]);
      expect(resolved.history.find((item?: any) : any => item.alertId === alert.alertId)).toMatchObject({
        lifecycleStatus: "resolved",
        lifecycleRevision: 3,
        active: false
      });

      const archived: any = await transitionMonitorAlertLifecycle(userDataPath, alert.alertId, "archive");
      expect(archived.history.find((item?: any) : any => item.alertId === alert.alertId)).toMatchObject({
        lifecycleStatus: "archived",
        lifecycleRevision: 4
      });
      await expect(transitionMonitorAlertLifecycle(userDataPath, alert.alertId, "acknowledge"))
        .rejects.toMatchObject({ code: "ALERT_LIFECYCLE_INVALID_TRANSITION" });
    });
  });

  it("serializes observation and acknowledgement so a slow cycle cannot erase operator state", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      await saveMonitorAlertConfig(userDataPath, {
        enabled: true,
        rules: { queueInterrupted: { enabled: true, severity: "critical" } }
      });
      const item: Record<string, any> = {
        workItemId: "concurrent-work-item",
        queueDefinitionId: "queue.jobs.import-parse",
        observationStatus: "interrupted",
        state: "failed"
      };
      const initial: any = await runMonitorAlertCycle(userDataPath, {
        workQueueObservation: { inspect: async () : Promise<any> => ({ items: [item] }) }
      });
      let releaseInspection: any;
      const inspectionStarted: any = new Promise((resolve?: any) : any => {
        releaseInspection = resolve;
      });
      let markInspectionStarted: any;
      const cycleEnteredInspection: any = new Promise((resolve?: any) : any => {
        markInspectionStarted = resolve;
      });
      const slowCycle: any = runMonitorAlertCycle(userDataPath, {
        workQueueObservation: {
          async inspect() : Promise<any> {
            markInspectionStarted();
            await inspectionStarted;
            return { items: [item] };
          }
        }
      });
      await cycleEnteredInspection;
      const acknowledgement: any = acknowledgeMonitorAlert(userDataPath, initial.activeAlerts[0].alertId);
      releaseInspection();
      await slowCycle;
      const acknowledged: any = await acknowledgement;

      expect(acknowledged.activeAlerts[0]).toMatchObject({
        lifecycleStatus: "acknowledged",
        lifecycleRevision: 2
      });
      const persisted: any = await getMonitorAlertState(userDataPath, { refresh: false });
      expect(persisted.activeAlerts[0].lifecycleStatus).toBe("acknowledged");
    });
  });

  it("executes suppression and notification failure through the same lifecycle", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      await configureProcessAlert(userDataPath);
      getBackgroundProcessStatusMock.mockResolvedValue(processStatus("missing"));
      const alert: any = (await runMonitorAlertCycle(userDataPath)).activeAlerts[0];

      const suppressed: any = await transitionMonitorAlertLifecycle(userDataPath, alert.alertId, "suppress");
      expect(suppressed.activeAlerts).toEqual([]);
      expect(suppressed.history.find((item?: any) : any => item.alertId === alert.alertId).lifecycleStatus).toBe("suppressed");

      const refired: any = await runMonitorAlertCycle(userDataPath);
      expect(refired.activeAlerts[0].lifecycleStatus).toBe("firing");
      const failed: any = await transitionMonitorAlertLifecycle(userDataPath, alert.alertId, "notification_failed");
      expect(failed.activeAlerts[0]).toMatchObject({ lifecycleStatus: "notification_failed", active: true });
      expect(failed.summary.notificationFailedCount).toBe(1);
    });
  });

  it("projects queue alerts without raw ids paths owners or evidence payloads", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      await saveMonitorAlertConfig(userDataPath, {
        enabled: true,
        rules: { queueInterrupted: { enabled: true, severity: "critical" } }
      });
      const workQueueObservation: Record<string, any> = {
        inspect: vi.fn(async () : Promise<any> => ({
          items: [{
            workItemId: "work-public-reference",
            queueDefinitionId: "queue.jobs.import-parse",
            observationStatus: "interrupted",
            state: "failed",
            privateProjectionInput: "private file content"
          }]
        }))
      };
      const state: any = await runMonitorAlertCycle(userDataPath, { workQueueObservation });
      const serialized: any = JSON.stringify(state);
      expect(state.activeAlerts).toHaveLength(1);
      expect(state.activeAlerts[0].alertId).toMatch(/^monitor\.queue\.[a-f0-9]{16}\.interrupted$/u);
      expect(serialized).not.toContain("work-public-reference");
      expect(serialized).not.toContain("private file content");
      expect(serialized).not.toContain(userDataPath);
      expect(state.workQueueObservation).toEqual({ observed: true, itemCount: 1, statusCounts: { interrupted: 1 } });
      await acknowledgeMonitorAlert(userDataPath, state.activeAlerts[0].alertId, { workQueueObservation });
      expect(Object.keys(workQueueObservation)).toEqual(["inspect"]);
    });
  });

  it("cancels before mutation and rejects cycles outside duration or capacity budgets", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      await configureProcessAlert(userDataPath);
      const controller: any = new AbortController();
      controller.abort();
      await expect(runMonitorAlertCycle(userDataPath, { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError", code: "observability_cancelled" });
      await expect(fs.stat(monitorAlertStatePath(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });

      getBackgroundProcessStatusMock.mockResolvedValue(processStatus("missing"));
      const now: any = vi.fn().mockReturnValueOnce(0).mockReturnValue(OBSERVABILITY_BUDGETS.maxCycleDurationMs + 1);
      await expect(runMonitorAlertCycle(userDataPath, {
        budgetClock: {
          now,
          cpuUsage: vi.fn((start?: any) : any => start ? { user: 0, system: 0 } : { user: 0, system: 0 }),
          rss: vi.fn(() : any => 0)
        }
      })).rejects.toMatchObject({ code: "observability_duration_budget_exceeded" });
      await expect(fs.stat(monitorAlertStatePath(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });

      getBackgroundProcessStatusMock.mockResolvedValue({
        supervisor: { alive: true },
        processes: Array.from({ length: OBSERVABILITY_BUDGETS.maxActiveAlerts + 1 }, (_?: any, index?: any) : any => ({
          role: `worker-${index}`,
          status: "missing",
          desired: true,
          restartCount: 0
        }))
      });
      await expect(runMonitorAlertCycle(userDataPath))
        .rejects.toMatchObject({ code: "observability_active_alert_budget_exceeded" });
      await expect(fs.stat(monitorAlertStatePath(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns a privacy-safe cached state and rejects empty alert ids", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const cached: any = await getMonitorAlertState(userDataPath, { refresh: false });
      expect(cached).toMatchObject({ ok: true, status: "unconfigured", reason: "configuration_missing" });
      expect(cached.configPath).toBeUndefined();
      expect(cached.statePath).toBeUndefined();
      await expect(acknowledgeMonitorAlert(userDataPath, "  "))
        .rejects.toMatchObject({ code: "alert_id_required" });
    });
  });
});
