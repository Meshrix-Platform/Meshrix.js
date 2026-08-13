import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { seedClientAdapterCache } from "../../../tools/server-scripts/lib/release-journey-adapter.ts";

const repoRoot: any = path.resolve(".");
const temporaryRoots: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  delete process.env.MESHRIX_MCP_PI_CONFIG;
});

describe("Pi adapter isolated cache", () : any => {
  it("copies the complete runtime dependency closure and runs the cached extension", async () : Promise<any> => {
    const temporaryRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pi-cache-"));
    temporaryRoots.push(temporaryRoot);
    const cacheRoot: any = path.join(temporaryRoot, "cache");
    const receipt: any = await seedClientAdapterCache({
      repoRoot,
      target: "pi",
      adapterSource: path.join(repoRoot, "plugins", "agents"),
      cacheRoot
    });
    expect(receipt.descriptorOk).toBe(true);

    const treeRoot: any = path.join(cacheRoot, "pi", "0.0.1", "tree");
    await expect(fs.stat(path.join(treeRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json")))
      .resolves.toMatchObject({});
    await expect(fs.stat(path.join(treeRoot, "node_modules", "typebox", "package.json")))
      .resolves.toMatchObject({});

    const configPath: any = path.join(temporaryRoot, "pi.json");
    await fs.writeFile(configPath, `${JSON.stringify({
      command: process.execPath,
      args: [path.join(repoRoot, "tests", "plugins", "fixtures", "pi-mcp-server.mjs")]
    })}\n`, { mode: 0o600 });
    process.env.MESHRIX_MCP_PI_CONFIG = configPath;

    const extensionPath: any = path.join(
      treeRoot,
      "node_modules",
      "@meshrix",
      "agent-pi-adapter",
      "extension.mjs"
    );
    const extensionModule: any = await import(`${pathToFileURL(extensionPath).href}?cache=${Date.now()}`);
    const handlers: any = new Map<any, any>();
    const tools: any[] = [];
    await extensionModule.default({
      on(name?: any, handler?: any) { handlers.set(name, handler); },
      registerTool(tool?: any) { tools.push(tool); }
    });
    await handlers.get("session_start")({}, { ui: { notify() {} } });
    expect(tools.map((tool?: any) : any => tool.name)).toContain("mcp_lico_file_convert");
    await expect(tools[0].execute("call-1", { source: "isolated.txt" })).resolves.toMatchObject({
      content: [{ type: "text", text: "converted:isolated.txt" }]
    });
    await handlers.get("session_shutdown")();
  });
});
