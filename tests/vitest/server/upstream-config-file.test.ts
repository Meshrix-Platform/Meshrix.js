import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createUpstreamConfigFileLoader } from "../../../packages/server-runtime/src/composition/upstream-config-file.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("declarative upstream config file", () => {
  it("preserves allowed MCP context headers at the publishing boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-config-"));
    roots.push(root);
    const configDirectory = path.join(root, "upstream-config");
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.writeFile(path.join(configDirectory, "services.json"), `${JSON.stringify({
      services: [{
        name: "fixture-context-service",
        type: "mcp",
        url: "https://fixture.example.invalid:443/mcp",
        headers: { "x-fixture-context": "alpha" }
      }]
    })}\n`);
    const commands: any[] = [];
    const publishingApplication: any = {
      list: async () => ({ setRevision: 0, services: [] }),
      execute: async (raw: string) => {
        const command = JSON.parse(raw);
        commands.push(command);
        return { serviceId: "fixture-service", serviceRevision: 1, setRevision: 1 };
      }
    };
    const loader = createUpstreamConfigFileLoader({ userDataPath: root, publishingApplication });
    try {
      await loader.start();
      expect(commands).toHaveLength(1);
      expect(commands[0].descriptor).toMatchObject({
        serviceProtocol: "mcp",
        mcp: {
          transport: "http",
          url: "https://fixture.example.invalid:443/mcp",
          headers: { "x-fixture-context": "alpha" }
        }
      });
    } finally {
      await loader.close();
    }
  });
});
