import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveInstalledClientAdapter } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";

const temporaryRoots: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  delete process.env.MESHRIX_MCP_PI_CONFIG;
});

describe("Pi adapter installed component", () : any => {
  it("loads the local extension from the resolved root component and calls its MCP tool", async () : Promise<any> => {
    const temporaryRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pi-component-"));
    temporaryRoots.push(temporaryRoot);
    const installed: any = await resolveInstalledClientAdapter({ target: "pi" });
    expect(installed.adapter).toMatchObject({
      packageName: "@meshrix/agent-pi-adapter",
      version: "0.0.1",
      source: "meshrix-root-bundle"
    });

    const configPath: any = path.join(temporaryRoot, "pi.json");
    await fs.writeFile(configPath, `${JSON.stringify({
      command: process.execPath,
      args: [path.resolve("tests/plugins/fixtures/pi-mcp-server.mjs")]
    })}\n`, { mode: 0o600 });
    process.env.MESHRIX_MCP_PI_CONFIG = configPath;

    const extensionPath: any = path.join(installed.packageRoot, "extension.mjs");
    const extensionModule: any = await import(`${pathToFileURL(extensionPath).href}?component=${Date.now()}`);
    const handlers: any = new Map<any, any>();
    const tools: any[] = [];
    await extensionModule.default({
      on(name?: any, handler?: any) { handlers.set(name, handler); },
      registerTool(tool?: any) { tools.push(tool); }
    });
    await handlers.get("session_start")({}, { ui: { notify() {} } });
    expect(tools.map((tool?: any) : any => tool.name)).toContain("mcp_lico_file_convert");
    await expect(tools[0].execute("call-1", { source: "installed.txt" })).resolves.toMatchObject({
      content: [{ type: "text", text: "converted:installed.txt" }]
    });
    await handlers.get("session_shutdown")();
  });
});
