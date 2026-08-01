import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";

describe("agent workspace controlled local-directory Host capability", () : any => {
  it("is absent by default and available only after generic capability enablement", () : any => {
    const userDataPath: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-agent-workspace-capability-"));
    let disabledRuntime: any;
    let enabledRuntime: any;
    try {
      disabledRuntime = createAgentWorkspace({
        userDataPath: path.join(userDataPath, "disabled")
      });
      enabledRuntime = createAgentWorkspace({
        userDataPath: path.join(userDataPath, "enabled"),
        controlledLocalDirectoryHostEnabled: true
      });

      expect(disabledRuntime.createLocalDirectoryMountSelection).toBeUndefined();
      expect(disabledRuntime.connectLocalDirectory).toBeUndefined();
      expect(disabledRuntime.moveLocalDirectoryItem).toBeUndefined();
      expect(enabledRuntime.createLocalDirectoryMountSelection).toBeTypeOf("function");
      expect(enabledRuntime.connectLocalDirectory).toBeTypeOf("function");
      expect(enabledRuntime.moveLocalDirectoryItem).toBeTypeOf("function");
    } finally {
      disabledRuntime?.close?.();
      enabledRuntime?.close?.();
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous non-boolean enablement", () : any => {
    expect(() : any => createAgentWorkspace({
      userDataPath: path.join(os.tmpdir(), "unused-agent-workspace-capability"),
      controlledLocalDirectoryHostEnabled: "true"
    })).toThrow("Controlled local-directory Host enablement must be a boolean.");
  });
});
