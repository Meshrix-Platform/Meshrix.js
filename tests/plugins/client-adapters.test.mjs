import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { ADAPTER_PROTOCOL, API_KEY_HEADER, invokeAdapter, parseJsonc } from "@meshrix/client-adapter-kit";
import { adapter as antigravity } from "../../plugins/agents/antigravity/adapter.mjs";
import { adapter as claudeCode } from "../../plugins/agents/claude-code/adapter.mjs";
import { adapter as codex } from "../../plugins/agents/codex/adapter.mjs";
import { adapter as kimi } from "../../plugins/agents/kimi/adapter.mjs";
import { adapter as openclaw } from "../../plugins/agents/openclaw/adapter.mjs";
import { adapter as opencode } from "../../plugins/agents/opencode/adapter.mjs";
import { adapter as pi } from "../../plugins/agents/pi/adapter.mjs";

const supported = [codex, claudeCode, openclaw, opencode, pi];
const base = { schemaVersion: ADAPTER_PROTOCOL, baseUrl: "https://gateway.invalid", serverName: "work", credentialRef: { kind: "env", name: "MESHRIX_WORK_KEY" } };
async function fixture(t, adapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-native-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "client");
  await fs.copyFile(path.resolve("tests/plugins/fixtures/fake-mcp-client.mjs"), executable);
  await fs.chmod(executable, 0o700);
  const file = path.join(root, adapter === codex ? "config.toml" : "config.json");
  const request = { ...base, client: { command: executable, configPath: file, marketplaceRoot: path.join(root, "marketplace") } };
  const rootKey = adapter === codex ? "mcp_servers" : adapter === opencode ? "mcp" : "mcpServers";
  const read = async () => {
    const text = await fs.readFile(file, "utf8");
    return adapter === codex ? JSON.parse(JSON.stringify(parse(text))) : JSON.parse(text);
  };
  const entries = (config) => adapter === openclaw ? config.mcp.servers : config[rootKey];
  const write = (entry) => fs.writeFile(file, adapter === codex ? stringify(entry) : JSON.stringify(entry));
  const initial = { preference: "untouched", ...(adapter === openclaw ? { mcp: { servers: { other: { command: "other" } } } } : { [rootKey]: { other: { command: "other" } } }) };
  await write(initial);
  return { root, file, request, initial, read, write, entries };
}
function expected(adapter) {
  if (adapter === codex) return { url: `${base.baseUrl}/mcp`, env_http_headers: { [API_KEY_HEADER]: base.credentialRef.name } };
  const headers = { [API_KEY_HEADER]: adapter === opencode ? "{env:MESHRIX_WORK_KEY}" : "${MESHRIX_WORK_KEY}" };
  return { ...(adapter === claudeCode ? { type: "http" } : adapter === opencode ? { type: "remote", oauth: false } : adapter === openclaw ? { transport: "streamable-http" } : {}), url: `${base.baseUrl}/mcp`, headers };
}

for (const adapter of supported) {
  test(`${adapter.description.target}: native registration, exact verification and non-destructive removal`, async (t) => {
    const f = await fixture(t, adapter);
    const authFile = path.join(f.root, "native-auth.json");
    await fs.writeFile(authFile, "opaque synthetic native authentication data");
    assert.equal((await invokeAdapter(adapter, "scan", f.request)).available, true);
    assert.deepEqual(await invokeAdapter(adapter, "install", f.request), { installed: true, status: "configured", credentialStatus: "external-reference-unverified", connectivity: "not-run" });
    const config = await f.read();
    assert.deepEqual(f.entries(config).work, expected(adapter));
    assert.equal(config.preference, "untouched");
    assert.deepEqual(f.entries(config).other, { command: "other" });
    assert.equal((await invokeAdapter(adapter, "verify", f.request)).installed, true);
    const bytes = await fs.readFile(f.file, "utf8");
    await invokeAdapter(adapter, "install", f.request);
    assert.equal(await fs.readFile(f.file, "utf8"), bytes);
    assert.deepEqual(await invokeAdapter(adapter, "uninstall", f.request), { removed: true, installed: false, credentialsPreserved: true });
    assert.deepEqual(await f.read(), f.initial);
    assert.equal(await fs.readFile(authFile, "utf8"), "opaque synthetic native authentication data");
  });

  test(`${adapter.description.target}: conflicts preserve endpoint, credentials and native policies`, async (t) => {
    const f = await fixture(t, adapter);
    await invokeAdapter(adapter, "install", f.request);
    const config = await f.read();
    Object.assign(f.entries(config).work, { enabled: false, disabledTools: ["write"], description: "retained" });
    const extraHeaders = adapter === codex ? "http_headers" : "headers";
    f.entries(config).work[extraHeaders] = { ...f.entries(config).work[extraHeaders], "X-Context": "synthetic-public-scope" };
    await f.write(config);
    await invokeAdapter(adapter, "install", f.request);
    assert.deepEqual(f.entries(await f.read()).work, f.entries(config).work);
    const before = await fs.readFile(f.file, "utf8");
    for (const request of [
      { ...f.request, baseUrl: "https://different.invalid" },
      { ...f.request, credentialRef: { kind: "env", name: "ANOTHER_IDENTITY" } }
    ]) {
      assert.equal((await invokeAdapter(adapter, "verify", request)).installed, false);
      for (const action of ["install", "uninstall"]) await assert.rejects(() => invokeAdapter(adapter, action, request), { adapterCode: "registration_conflict" });
      assert.equal(await fs.readFile(f.file, "utf8"), before);
    }
    f.entries(config).work.auth = "oauth";
    await f.write(config);
    const oauthBefore = await fs.readFile(f.file, "utf8");
    await assert.rejects(() => invokeAdapter(adapter, "uninstall", f.request), { adapterCode: "registration_conflict" });
    assert.equal(await fs.readFile(f.file, "utf8"), oauthBefore);
  });

  test(`${adapter.description.target}: migrate only an identified proxy with the same binding`, async (t) => {
    const f = await fixture(t, adapter);
    const args = ["proxy", "--target", adapter.description.target, "--url", base.baseUrl, "--token-env", base.credentialRef.name];
    const old = adapter === opencode ? { type: "local", command: ["meshrix-mcp", ...args] } : { command: "meshrix-mcp", args };
    const config = await f.read();
    f.entries(config).work = { ...old, enabled: false, disabledTools: ["write"] };
    await f.write(config);
    await invokeAdapter(adapter, "install", f.request);
    assert.deepEqual(f.entries(await f.read()).work, { enabled: false, disabledTools: ["write"], ...expected(adapter) });
  });
}

for (const adapter of [kimi, antigravity]) {
  test(`${adapter.description.target}: unqualified protected header reference fails before mutation`, async (t) => {
    const f = await fixture(t, adapter);
    const before = await fs.readFile(f.file, "utf8");
    await assert.rejects(() => invokeAdapter(adapter, "install", f.request), { adapterCode: "unsupported_protected_header_reference" });
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.equal((await invokeAdapter(adapter, "verify", f.request)).installed, false);
    assert.equal((await invokeAdapter(adapter, "describe")).nativeRegistration.supported, false);
  });
}

test("Codex disables only its positively identified generated marketplace duplicate", async (t) => {
  const f = await fixture(t, codex);
  const request = { ...f.request, serverName: "lico" };
  const plugin = path.join(request.client.marketplaceRoot, "plugins", "lico");
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "lico", description: "Meshrix MCP integration for Codex.", license: "Apache-2.0", mcpServers: "./.mcp.json" }));
  const asset = JSON.stringify({ mcpServers: { lico: { command: "meshrix-mcp", args: ["proxy", "--target", "codex", "--url", base.baseUrl, "--token-env", base.credentialRef.name] } } });
  await fs.writeFile(path.join(plugin, ".mcp.json"), asset);
  await invokeAdapter(codex, "install", request);
  assert.equal((await f.read()).plugins["lico@meshrix-local"].enabled, false);
  assert.equal(await fs.readFile(path.join(plugin, ".mcp.json"), "utf8"), asset);
  await invokeAdapter(codex, "uninstall", request);
  assert.equal(await fs.readFile(path.join(plugin, ".mcp.json"), "utf8"), asset);
});

test("JSONC parsing preserves comma-like text, URLs and comments after trailing commas", () => {
  assert.throws(() => parseJsonc('{"value":1/* separator */2}'));
  assert.deepEqual(parseJsonc('{"values":[1, /* first */ /* second */ 2]}'), { values: [1, 2] });
  assert.deepEqual(parseJsonc('{ "url":"https://example.invalid/a,}", "values":["x,]", /*comment*/], // comment\n}'), { url: "https://example.invalid/a,}", values: ["x,]"] });
});

test("OpenCode requires explicit OAuth disablement before recognizing or removing a static-key registration", async (t) => {
  const f = await fixture(t, opencode);
  const config = await f.read();
  const { oauth: _oauth, ...entry } = expected(opencode);
  f.entries(config).work = entry;
  await f.write(config);
  const before = await fs.readFile(f.file, "utf8");
  assert.equal((await invokeAdapter(opencode, "verify", f.request)).installed, false);
  for (const action of ["install", "uninstall"]) await assert.rejects(() => invokeAdapter(opencode, action, f.request), { adapterCode: "registration_conflict" });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("Pi rejects tool-namespace collisions without touching either registration", async (t) => {
  const f = await fixture(t, pi);
  const config = await f.read();
  config.mcpServers["work-key"] = { command: "independent-server" };
  await f.write(config);
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(() => invokeAdapter(pi, "install", { ...f.request, serverName: "work_key" }), { adapterCode: "registration_conflict" });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("Claude reserved provider-variable references fail before mutation", async (t) => {
  const f = await fixture(t, claudeCode);
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(() => invokeAdapter(claudeCode, "install", { ...f.request, credentialRef: { kind: "env", name: "ANTHROPIC_API_KEY" } }), { adapterCode: "unsupported_credential_reference" });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("detection is separate from malformed configuration", async (t) => {
  const f = await fixture(t, pi);
  await fs.writeFile(f.file, "not JSON");
  const result = await invokeAdapter(pi, "scan", f.request);
  assert.equal(result.available, true);
  assert.equal(result.installed, false);
  assert.equal(result.status, "configuration-error");
  await assert.rejects(() => invokeAdapter(pi, "install", f.request), { adapterCode: "invalid_client_config" });
  assert.equal(await fs.readFile(f.file, "utf8"), "not JSON");
});

test("raw credentials and obsolete connector requests are rejected before mutation", async () => {
  for (const payload of [{ token: "forbidden" }, { connector: { command: "node", args: [] } }, { client: { command: `mxak1.${"a".repeat(22)}.${"b".repeat(43)}` } }]) {
    await assert.rejects(() => invokeAdapter(pi, "install", { ...base, ...payload }), { adapterCode: "raw_secret_rejected" });
  }
});
