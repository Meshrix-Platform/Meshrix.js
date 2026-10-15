import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FileAcpAgentRegistry } from "../../../apps/entry-gui/src/main/agent/agent-registry.ts";

describe("local ACP Agent registry", () => {
  it("preserves concurrent registrations in its serialized read-modify-write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meshrix-agent-registry-"));
    try {
      const filePath = path.join(root, "agents.json");
      const registry = new FileAcpAgentRegistry({
        filePath,
        secretResolver: { async resolve() { return null; } }
      });
      const definition = (id: string, displayName: string) => ({
        id,
        displayName,
        description: null,
        command: process.execPath,
        args: [],
        cwd: root,
        environment: {},
        permissionPolicy: "ask" as const,
        enabled: true
      });

      await Promise.all([
        registry.register(definition("agent.concurrent.first", "First")),
        registry.register(definition("agent.concurrent.second", "Second"))
      ]);

      expect((await registry.list()).map((agent) => agent.id).sort()).toEqual([
        "agent.concurrent.first",
        "agent.concurrent.second"
      ]);
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as { agents: Record<string, unknown> };
      expect(Object.keys(persisted.agents).sort()).toEqual([
        "agent.concurrent.first",
        "agent.concurrent.second"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });
});
