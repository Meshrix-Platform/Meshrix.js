import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ADAPTER_PROTOCOL, invokeAdapter } from "@meshrix/client-adapter-kit";
import { adapter as antigravity } from "../../plugins/agents/antigravity/adapter.mjs";
import { adapter as claudeCode } from "../../plugins/agents/claude-code/adapter.mjs";
import { adapter as codex } from "../../plugins/agents/codex/adapter.mjs";
import { adapter as kimi } from "../../plugins/agents/kimi/adapter.mjs";
import { adapter as openclaw } from "../../plugins/agents/openclaw/adapter.mjs";
import { adapter as opencode } from "../../plugins/agents/opencode/adapter.mjs";
import { adapter as pi } from "../../plugins/agents/pi/adapter.mjs";

const connector = { command: process.execPath, args: ["connector.mjs"] };

test("all client adapters expose the closed JSON-stdio contract", async () => {
  for (const adapter of [antigravity, claudeCode, codex, kimi, openclaw, opencode, pi]) {
    const result = await invokeAdapter(adapter, "describe");
    assert.equal(result.protocol, ADAPTER_PROTOCOL);
    assert.deepEqual(result.actions, ["describe", "scan", "install", "verify", "uninstall"]);
    assert.deepEqual(result.locations, ["local"]);
  }
  await assert.rejects(() => invokeAdapter(codex, "install", { token: "forbidden" }), /Raw credential field is forbidden/u);
});

test("CLI adapters complete local install, verify, and uninstall", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-adapter-test-"));
  const executable = path.join(root, "fake-client");
  await fs.copyFile(path.resolve("tests/plugins/fixtures/fake-mcp-client.mjs"), executable);
  await fs.chmod(executable, 0o700);
  const previousState = process.env.MESHRIX_FAKE_CLIENT_STATE;
  process.env.MESHRIX_FAKE_CLIENT_STATE = path.join(root, "state.json");
  t.after(async () => { if (previousState === undefined) delete process.env.MESHRIX_FAKE_CLIENT_STATE; else process.env.MESHRIX_FAKE_CLIENT_STATE = previousState; await fs.rm(root, { recursive: true, force: true }); });
  const request = { schemaVersion: ADAPTER_PROTOCOL, baseUrl: "http://127.0.0.1:3010", tokenEnv: "MESHRIX_MCP_TOKEN", connector, client: { command: executable } };
  for (const adapter of [codex, claudeCode, openclaw]) {
    await fs.writeFile(process.env.MESHRIX_FAKE_CLIENT_STATE, '{"installed":false}\n');
    assert.equal((await invokeAdapter(adapter, "scan", request)).available, true);
    assert.equal((await invokeAdapter(adapter, "install", request)).installed, true);
    assert.equal((await invokeAdapter(adapter, "verify", request)).installed, true);
    const removed = await invokeAdapter(adapter, "uninstall", request);
    assert.equal(removed.removed, true);
    assert.equal(removed.installed, false);
  }
});

test("configuration and Pi adapters preserve unrelated state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-config-adapter-test-"));
  const executable = path.join(root, "fake-client");
  await fs.copyFile(path.resolve("tests/plugins/fixtures/fake-mcp-client.mjs"), executable);
  await fs.chmod(executable, 0o700);
  const previousState = process.env.MESHRIX_FAKE_CLIENT_STATE;
  process.env.MESHRIX_FAKE_CLIENT_STATE = path.join(root, "state.json");
  t.after(async () => { if (previousState === undefined) delete process.env.MESHRIX_FAKE_CLIENT_STATE; else process.env.MESHRIX_FAKE_CLIENT_STATE = previousState; await fs.rm(root, { recursive: true, force: true }); });
  const base = { schemaVersion: ADAPTER_PROTOCOL, baseUrl: "http://127.0.0.1:3010", tokenEnv: "MESHRIX_MCP_TOKEN", connector, client: { command: executable } };

  const openCodePath = path.join(root, "opencode.jsonc");
  await fs.writeFile(openCodePath, '{ // retained\n "theme": "dark",\n}\n');
  const openCodeRequest = { ...base, client: { command: executable, configPath: openCodePath } };
  assert.equal((await invokeAdapter(opencode, "install", openCodeRequest)).installed, true);
  await invokeAdapter(opencode, "uninstall", openCodeRequest);
  assert.equal(JSON.parse(await fs.readFile(openCodePath, "utf8")).theme, "dark");

  const kimiPath = path.join(root, "kimi-mcp.json");
  await fs.writeFile(kimiPath, '{ "mcpServers": { "other": { "command": "other" } } }\n');
  const kimiRequest = { ...base, client: { command: executable, configPath: kimiPath } };
  assert.equal((await invokeAdapter(kimi, "scan", kimiRequest)).available, true);
  assert.equal((await invokeAdapter(kimi, "install", kimiRequest)).installed, true);
  const kimiConfig = JSON.parse(await fs.readFile(kimiPath, "utf8"));
  assert.deepEqual(kimiConfig.mcpServers.lico, { command: connector.command, args: [...connector.args, "proxy", "--target", "kimi", "--url", base.baseUrl, "--token-env", base.tokenEnv] });
  assert.equal((await invokeAdapter(kimi, "verify", kimiRequest)).installed, true);
  assert.equal((await invokeAdapter(kimi, "uninstall", kimiRequest)).removed, true);
  const kimiRemaining = JSON.parse(await fs.readFile(kimiPath, "utf8"));
  assert.equal(kimiRemaining.mcpServers.other.command, "other");
  assert.equal(Boolean(kimiRemaining.mcpServers.lico), false);

  const antigravityPath = path.join(root, "antigravity", "mcp_config.json");
  await fs.mkdir(path.dirname(antigravityPath), { recursive: true });
  await fs.writeFile(antigravityPath, '{ "theme": "retained" }\n');
  const antigravityRequest = { ...base, client: { command: executable, configPath: antigravityPath } };
  assert.equal((await invokeAdapter(antigravity, "scan", antigravityRequest)).available, true);
  assert.equal((await invokeAdapter(antigravity, "install", antigravityRequest)).installed, true);
  const antigravityConfig = JSON.parse(await fs.readFile(antigravityPath, "utf8"));
  assert.equal(antigravityConfig.theme, "retained");
  assert.deepEqual(antigravityConfig.mcpServers.lico, {
    command: connector.command,
    args: [...connector.args, "proxy", "--target", "antigravity", "--url", base.baseUrl, "--token-env", base.tokenEnv]
  });
  assert.equal((await invokeAdapter(antigravity, "verify", antigravityRequest)).installed, true);
  const antigravityRemoved = await invokeAdapter(antigravity, "uninstall", antigravityRequest);
  assert.equal(antigravityRemoved.installed, false);
  const antigravityRemaining = JSON.parse(await fs.readFile(antigravityPath, "utf8"));
  assert.equal(antigravityRemaining.theme, "retained");
  assert.equal("mcpServers" in antigravityRemaining, false);

  const piRequest = { ...base, client: { command: executable, configPath: path.join(root, "pi.json") } };
  assert.equal((await invokeAdapter(pi, "install", piRequest)).installed, true);
  const piState = JSON.parse(await fs.readFile(process.env.MESHRIX_FAKE_CLIENT_STATE, "utf8"));
  assert.equal(path.basename(piState.lastInstallSource), "pi");
  assert.equal((await invokeAdapter(pi, "verify", piRequest)).installed, true);
  assert.equal((await invokeAdapter(pi, "uninstall", piRequest)).installed, false);
});
