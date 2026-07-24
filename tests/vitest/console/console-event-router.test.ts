import { describe, expect, it, vi } from "vitest";

import {
  createConsoleEventRouter,
} from "../../../apps/console/composables/console-event-router";
import type { ProtocolEvent, ServerConsoleState, SplitJob } from "../../../apps/console/lib/types";

function state(settingsValue: Record<string, unknown> = {}) {
  return {
    server: {},
    runtime: {},
    settings: { value: settingsValue },
    jobs: {},
    clients: {},
  } as unknown as ServerConsoleState;
}

function event(topic: string, payload: unknown): ProtocolEvent {
  return { topic, payload } as ProtocolEvent;
}

function fixture(currentState: ServerConsoleState | null = state()) {
  const applyConsoleState = vi.fn();
  const applyMaintenanceConfig = vi.fn(() => true);
  const refreshMaintenanceSilently = vi.fn();
  const removeJob = vi.fn(() => true);
  const upsertJob = vi.fn(() => true);
  return {
    applyConsoleState,
    applyMaintenanceConfig,
    applyServerEvent: createConsoleEventRouter({
      applyConsoleState,
      applyMaintenanceConfig,
      getConsoleState: () => currentState,
      refreshMaintenanceSilently,
      removeJob,
      upsertJob,
    }),
    refreshMaintenanceSilently,
    removeJob,
    upsertJob,
  };
}

describe("console event router", () => {
  it("rejects an invalid console state without mutating state", () => {
    const target = fixture();
    expect(target.applyServerEvent(event("system.console_state", { state: { server: {} } }))).toBe(false);
    expect(target.applyConsoleState).not.toHaveBeenCalled();
  });

  it("routes job upsert and deletion events to the job boundary", () => {
    const target = fixture();
    const job = { id: "job-1" } as SplitJob;
    expect(target.applyServerEvent(event("jobs.job", { job }))).toBe(true);
    expect(target.applyServerEvent(event("jobs.deleted", { jobId: "job-1" }))).toBe(true);
    expect(target.upsertJob).toHaveBeenCalledWith(job);
    expect(target.removeJob).toHaveBeenCalledWith("job-1");
  });

  it("projects settings through the state owner without writing a draft directly", () => {
    const current = state({ provider: "configured" });
    const target = fixture(current);
    expect(target.applyServerEvent(event("settings.current", { value: {} }))).toBe(true);
    expect(target.applyConsoleState).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ value: {} }),
    }));
  });

  it("routes maintenance configuration and run refresh independently", () => {
    const target = fixture();
    expect(target.applyServerEvent(event("maintenance.agent.config", { config: { enabled: true } }))).toBe(true);
    expect(target.applyMaintenanceConfig).toHaveBeenCalledWith({ enabled: true });
    expect(target.applyServerEvent(event("maintenance.agent.run.completed", { run: { id: "run-1" } }))).toBe(true);
    expect(target.refreshMaintenanceSilently).toHaveBeenCalledOnce();
  });

  it("ignores unknown topics without side effects", () => {
    const target = fixture();
    expect(target.applyServerEvent(event("unknown.topic", { value: true }))).toBe(false);
    expect(target.applyConsoleState).not.toHaveBeenCalled();
    expect(target.upsertJob).not.toHaveBeenCalled();
    expect(target.removeJob).not.toHaveBeenCalled();
    expect(target.applyMaintenanceConfig).not.toHaveBeenCalled();
    expect(target.refreshMaintenanceSilently).not.toHaveBeenCalled();
  });
});
