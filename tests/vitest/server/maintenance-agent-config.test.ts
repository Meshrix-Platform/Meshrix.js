import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_APPROVE_RISKS,
  EMPTY_MAINTENANCE_AGENT_CONFIG,
  MAINTENANCE_RUNBOOK_CATALOG,
  computeNextRunAt,
  getMaintenanceAgentAuditPath,
  getMaintenanceAgentConfigPath,
  getMaintenanceAgentRunsPath,
  loadMaintenanceAgentConfig,
  maxRisk,
  normalizeMaintenanceAgentConfig,
  normalizeRisk,
  saveMaintenanceAgentConfig,
  riskRank,
} from "../../../packages/agents/src/maintenance/config.ts";
import { createMaintenanceScheduler } from "../../../packages/agents/src/maintenance/scheduler.ts";
import { maintenanceScheduledRunId } from "../../../packages/agents/src/maintenance/reporting.ts";

async function withTempUserData(testCase?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-maintenance-agent-config-"));
  try {
    return await testCase(root);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

describe("maintenance agent config normalization", () : any => {
  it("normalizes risk levels and auto-approval boundaries", () : any => {
    expect(AUTO_APPROVE_RISKS).toEqual(["read_only", "safe_write"]);
    expect(normalizeRisk(" destructive ")).toBe("destructive");
    expect(normalizeRisk("unknown", "safe_write")).toBe("safe_write");
    expect(riskRank("repair_write")).toBeGreaterThan(riskRank("safe_write"));
    expect(maxRisk("read_only", "destructive", "safe_write")).toBe("destructive");
  });

  it("sanitizes schedules and clamps scheduler intervals", () : any => {
    const config: any = normalizeMaintenanceAgentConfig({
      enabled: true,
      plannerMode: "invalid",
      autoApproveRisk: "destructive",
      workloadGrantId: "maintenance-scheduled-grant",
      scheduler: { tickSeconds: 0 },
      schedules: [
        {
          id: "custom",
          label: "Custom",
          enabled: true,
          runbook: "missing",
          intervalMinutes: 0,
          nextRunAt: "2026-06-03T00:00:00.000Z",
        },
      ],
    });

    expect(config.enabled).toBe(true);
    expect(config.plannerMode).toBe("");
    expect(config.autoApproveRisk).toBe("");
    expect(config.workloadGrantId).toBe("maintenance-scheduled-grant");
    expect(config.scheduler.tickSeconds).toBe(0);
    expect(config.schedules[0]).toMatchObject({
      id: "custom",
      enabled: false,
      runbook: "",
      intervalMinutes: 0,
    });
    expect(config).not.toHaveProperty("runbooks");
    expect(MAINTENANCE_RUNBOOK_CATALOG.health_smoke.suggestedIntervalMinutes).toBe(60);
  });

  it("uses stable maintenance-agent state paths and next-run timestamps", () : any => {
    const root: any = "/tmp/meshrix-user-data";
    expect(getMaintenanceAgentConfigPath(root)).toBe("/tmp/meshrix-user-data/maintenance-agent.json");
    expect(getMaintenanceAgentAuditPath(root)).toBe("/tmp/meshrix-user-data/maintenance-agent-audit.jsonl");
    expect(getMaintenanceAgentRunsPath(root)).toBe("/tmp/meshrix-user-data/maintenance-agent-runs.jsonl");
    expect(computeNextRunAt({ intervalMinutes: 30 }, new Date("2026-06-03T00:00:00.000Z"))).toBe(
      "2026-06-03T00:30:00.000Z",
    );
  });

  it("persists normalized config and preserves scheduler clamp behavior through storage", async () : Promise<any> => {
    await withTempUserData(async (root?: any) : Promise<any> => {
      const configPath: any = getMaintenanceAgentConfigPath(root);
      const baseline: any = normalizeMaintenanceAgentConfig({
        enabled: true,
        plannerMode: "invalid",
        autoApproveRisk: "destructive",
        scheduler: { tickSeconds: 0 },
      });

      await fs.writeFile(configPath, JSON.stringify({
        enabled: baseline.enabled,
        plannerMode: baseline.plannerMode,
        autoApproveRisk: baseline.autoApproveRisk,
        scheduler: baseline.scheduler,
        schedules: [
          {
            id: "custom",
            label: "Custom",
            enabled: true,
            runbook: "missing",
            intervalMinutes: 0,
            nextRunAt: "2026-06-03T00:00:00.000Z",
          },
        ],
      }));

      const loaded: any = await loadMaintenanceAgentConfig(root);
      expect(loaded.autoApproveRisk).toBe("");
      expect(loaded.scheduler.tickSeconds).toBe(0);
      expect(loaded.plannerMode).toBe("");
      expect(loaded.schedules[0]).toMatchObject({
        id: "custom",
        runbook: "",
        enabled: false,
      });

      const saved: any = await saveMaintenanceAgentConfig(root, {
        enabled: false,
        plannerMode: "gateway",
        autoApproveRisk: "unknown",
        scheduler: { tickSeconds: -1 },
      });
      expect(saved.enabled).toBe(false);
      expect(saved.scheduler.tickSeconds).toBe(1);
      expect(saved.autoApproveRisk).toBe(EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk);

      const persisted: any = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(persisted.autoApproveRisk).toBe(EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk);
      expect(persisted.plannerMode).toBe("gateway");
    });
  });

  it("keeps a missing user configuration empty", async () : Promise<any> => {
    await withTempUserData(async (root?: any) : Promise<any> => {
      const loaded: any = await loadMaintenanceAgentConfig(root);
      expect(loaded).toEqual(EMPTY_MAINTENANCE_AGENT_CONFIG);
      expect(loaded.schedules).toEqual([]);
      expect(loaded.plannerMode).toBe("");
      expect(loaded.autoApproveRisk).toBe("");
    });
  });

  it("throws when local config file contains invalid JSON", async () : Promise<any> => {
    await withTempUserData(async (root?: any) : Promise<any> => {
      const configPath: any = getMaintenanceAgentConfigPath(root);
      await fs.writeFile(configPath, "not-json", "utf8");
      await expect(loadMaintenanceAgentConfig(root)).rejects.toThrow(SyntaxError);
    });
  });

  it("retains a failed due occurrence and advances only after durable admission", async () : Promise<any> => {
    await withTempUserData(async (root?: any) : Promise<any> => {
      const occurrenceAt: any = "2020-01-01T00:00:00.000Z";
      let config: any = normalizeMaintenanceAgentConfig({
        enabled: true,
        scheduler: { tickSeconds: 1 },
        schedules: [{
          id: "health-hourly",
          enabled: true,
          runbook: "health_smoke",
          intervalMinutes: 60,
          nextRunAt: occurrenceAt
        }]
      });
      const createScheduledRun: any = vi.fn()
        .mockRejectedValueOnce(new Error("admission unavailable"))
        .mockResolvedValueOnce({ runId: maintenanceScheduledRunId("health-hourly", occurrenceAt) });
      const scheduler: any = createMaintenanceScheduler({
        userDataPath: root,
        schedulerEnabled: false,
        getConfig: () : any => config,
        setConfig: (next?: any) : any => { config = next; },
        ensureStarted: async () : Promise<any> => {},
        createScheduledRun,
        publish: async () : Promise<any> => {},
        logMaintenance: () : any => {},
        state: { closed: false }
      });

      await scheduler.tickScheduler();
      expect(config.schedules[0].nextRunAt).toBe(occurrenceAt);
      await scheduler.tickScheduler();
      expect(createScheduledRun).toHaveBeenLastCalledWith(expect.objectContaining({ occurrenceAt }));
      expect(config.schedules[0].nextRunAt).not.toBe(occurrenceAt);
    });
  });

  it("derives one stable run identity for a schedule occurrence", () : any => {
    expect(maintenanceScheduledRunId("health-hourly", "2026-06-03T00:00:00.000Z"))
      .toBe(maintenanceScheduledRunId("health-hourly", "2026-06-03T00:00:00.000Z"));
    expect(maintenanceScheduledRunId("health-hourly", "2026-06-03T01:00:00.000Z"))
      .not.toBe(maintenanceScheduledRunId("health-hourly", "2026-06-03T00:00:00.000Z"));
  });
});
