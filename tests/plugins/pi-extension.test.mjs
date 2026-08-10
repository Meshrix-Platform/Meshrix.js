import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import piExtension, { piContent, piToolName } from "../../plugins/agents/pi/extension.mjs";

test("Pi extension discovers and invokes Meshrix MCP tools", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pi-extension-"));
  const configPath = path.join(temporaryRoot, "pi.json");
  const serverPath = path.resolve("tests/plugins/fixtures/pi-mcp-server.mjs");
  await fs.writeFile(configPath, `${JSON.stringify({ command: process.execPath, args: [serverPath] })}\n`, { mode: 0o600 });
  const previousConfig = process.env.MESHRIX_MCP_PI_CONFIG;
  process.env.MESHRIX_MCP_PI_CONFIG = configPath;
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.MESHRIX_MCP_PI_CONFIG;
    else process.env.MESHRIX_MCP_PI_CONFIG = previousConfig;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const handlers = new Map();
  const tools = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.push(tool); }
  };
  await piExtension(pi);
  await handlers.get("session_start")({}, { ui: { notify() {} } });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp_lico_file_convert");
  const result = await tools[0].execute("call-1", { source: "sample.txt" });
  assert.deepEqual(result.content, [{ type: "text", text: "converted:sample.txt" }]);
  await handlers.get("session_shutdown")();
});

test("Pi tool conversion is stable and preserves supported content", () => {
  const longName = piToolName("x".repeat(100));
  assert.equal(longName.length, 64);
  assert.deepEqual(piContent([{ type: "image", data: "AA==", mimeType: "image/png" }]), [
    { type: "image", data: "AA==", mimeType: "image/png" }
  ]);
});
