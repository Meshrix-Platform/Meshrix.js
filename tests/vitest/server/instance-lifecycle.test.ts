import { describe, expect, it } from "vitest";

import {
  INSTANCE_LIFECYCLE_ACTIONS,
  INSTANCE_LIFECYCLE_MODES,
  classifyRunningInstance,
  containerMatchesMode,
  parseInstanceLifecycleArgs,
  planInstanceRestart,
} from "../../../tools/server-scripts/instance-lifecycle.ts";

describe("instance lifecycle commands", () : any => {
  it("accepts the one-click start, stop, and restart modes", () : any => {
    expect([...INSTANCE_LIFECYCLE_ACTIONS]).toEqual(["start", "stop", "restart"]);
    expect([...INSTANCE_LIFECYCLE_MODES]).toEqual([
      "dev",
      "server",
      "console",
      "compose",
      "compose-ui",
      "offline",
    ]);
    expect(parseInstanceLifecycleArgs(["start", "offline"])).toEqual({
      action: "start",
      mode: "offline",
    });
    expect(parseInstanceLifecycleArgs(["stop", "compose-ui"])).toEqual({
      action: "stop",
      mode: "compose-ui",
    });
    expect(parseInstanceLifecycleArgs(["restart", "offline"])).toEqual({
      action: "restart",
      mode: "offline",
    });
  });

  it("rejects unknown actions or modes and classifies the running stack", () : any => {
    expect(() : any => parseInstanceLifecycleArgs(["up", "offline"])).toThrow(/start, stop, or restart/);
    expect(() : any => parseInstanceLifecycleArgs(["start", "vm"])).toThrow(/offline/);
    expect(classifyRunningInstance({
      container: { running: true, project: "meshrix-offline-vm", withUi: true },
    })).toBe("offline");
    expect(classifyRunningInstance({
      container: { running: true, project: "meshrixjs", withUi: false },
    })).toBe("compose");
    expect(classifyRunningInstance({
      container: { running: true, project: "meshrixjs", withUi: true },
    })).toBe("compose-ui");
    expect(classifyRunningInstance({
      container: { running: false },
      sourceProcess: "dev",
    })).toBe("dev");
  });

  it("restarts the same stack and refuses a different running mode", () : any => {
    expect(containerMatchesMode({
      present: true,
      running: false,
      project: "meshrix-offline-vm",
      withUi: true,
    }, "offline")).toBe(true);
    expect(containerMatchesMode({
      present: true,
      running: false,
      project: "meshrixjs",
      withUi: true,
    }, "offline")).toBe(false);
    expect(planInstanceRestart({
      current: "offline",
      mode: "offline",
      container: {
        present: true,
        running: true,
        project: "meshrix-offline-vm",
        withUi: true,
      },
    })).toEqual({
      ok: true,
      start: "existing",
    });
    expect(planInstanceRestart({
      current: "offline",
      mode: "compose-ui",
    })).toEqual({
      ok: false,
      code: "instance_lifecycle_wrong_mode",
    });
    expect(planInstanceRestart({
      current: "",
      mode: "offline",
    })).toEqual({
      ok: true,
      start: "fresh",
    });
  });
});
