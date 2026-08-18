import { describe, expect, it, vi } from "vitest";

import {
  createConsoleEventRouter,
} from "../../../apps/console/composables/console-event-router";
import type { ProtocolEvent, ServerConsoleState, SplitJob } from "../../../apps/console/lib/types";

function state(settingsValue: Record<string, unknown> = {}) : any {
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

function fixture(currentState: ServerConsoleState | null = state()) : any {
  const applyConsoleState: any = vi.fn();
  const removeJob: any = vi.fn(() : any => true);
  const upsertJob: any = vi.fn(() : any => true);
  return {
    applyConsoleState,
    applyServerEvent: createConsoleEventRouter({
      applyConsoleState,
      getConsoleState: () : any => currentState,
      removeJob,
      upsertJob,
    }),
    removeJob,
    upsertJob,
  };
}

describe("console event router", () : any => {
  it("rejects an invalid console state without mutating state", () : any => {
    const target: any = fixture();
    expect(target.applyServerEvent(event("system.console_state", { state: { server: {} } }))).toBe(false);
    expect(target.applyConsoleState).not.toHaveBeenCalled();
  });

  it("routes job upsert and deletion events to the job boundary", () : any => {
    const target: any = fixture();
    const job: any = { id: "job-1" } as SplitJob;
    expect(target.applyServerEvent(event("jobs.job", { job }))).toBe(true);
    expect(target.applyServerEvent(event("jobs.deleted", { jobId: "job-1" }))).toBe(true);
    expect(target.upsertJob).toHaveBeenCalledWith(job);
    expect(target.removeJob).toHaveBeenCalledWith("job-1");
  });

  it("projects settings through the state owner without writing a draft directly", () : any => {
    const current: any = state({ provider: "configured" });
    const target: any = fixture(current);
    expect(target.applyServerEvent(event("settings.current", { value: {} }))).toBe(true);
    expect(target.applyConsoleState).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ value: {} }),
    }));
  });

  it("ignores retired maintenance events without side effects", () : any => {
    const target: any = fixture();
    expect(target.applyServerEvent(event("maintenance.agent.config", { config: { enabled: true } }))).toBe(false);
    expect(target.applyServerEvent(event("maintenance.agent.run.completed", { run: { id: "run-1" } }))).toBe(false);
    expect(target.applyConsoleState).not.toHaveBeenCalled();
    expect(target.upsertJob).not.toHaveBeenCalled();
    expect(target.removeJob).not.toHaveBeenCalled();
  });

  it("ignores unknown topics without side effects", () : any => {
    const target: any = fixture();
    expect(target.applyServerEvent(event("unknown.topic", { value: true }))).toBe(false);
    expect(target.applyConsoleState).not.toHaveBeenCalled();
    expect(target.upsertJob).not.toHaveBeenCalled();
    expect(target.removeJob).not.toHaveBeenCalled();
  });
});
