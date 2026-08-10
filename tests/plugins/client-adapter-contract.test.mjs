import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ADAPTER_DESCRIPTOR_SCHEMA, ADAPTER_PROTOCOL } from "@meshrix/client-adapter-kit";

// Canonical client-adapter contract owned by Meshrix Core. These values are
// pinned by the Core connector and must never be edited in this repository:
// - Meshrix/packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.mjs
//   (`MCP_CLIENT_ADAPTER_PROTOCOL`, trusted adapter coordinates per target)
// - Meshrix/packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.mjs
//   (`CLIENT_ADAPTER_DESCRIPTOR_SCHEMA`, response envelope, `describeClientAdapter`
//   descriptor field checks)
// Any change here without a matching Core release breaks installation with
// CLIENT_ADAPTER_RESPONSE_INVALID / CLIENT_ADAPTER_DESCRIPTOR_MISMATCH.
const CANONICAL_PROTOCOL = "v0.0.1:meshrix:client-adapter-json-stdio-1";
const CANONICAL_DESCRIPTOR_SCHEMA = "v0.0.1:meshrix:client-adapter-descriptor-1";
const CANONICAL_ACTIONS = ["describe", "scan", "install", "verify", "uninstall"];
const CANONICAL_LOCATIONS = ["local"];
// Trusted targets and package coordinates from Core `MCP_CLIENT_TARGETS`.
const CANONICAL_TARGETS = ["antigravity", "claude-code", "codex", "kimi", "openclaw", "opencode", "pi"];

const agentsRoot = path.resolve("plugins", "agents");

test("kit constants match the Core-pinned protocol identifiers", () => {
  assert.equal(ADAPTER_PROTOCOL, CANONICAL_PROTOCOL);
  assert.equal(ADAPTER_DESCRIPTOR_SCHEMA, CANONICAL_DESCRIPTOR_SCHEMA);
});

test("every adapter descriptor satisfies the Core runner contract", async () => {
  for (const target of CANONICAL_TARGETS) {
    const packageName = `@meshrix/agent-${target}-adapter`;
    const declared = JSON.parse(await fs.readFile(path.join(agentsRoot, target, "adapter.json"), "utf8"));
    assert.equal(declared.schemaVersion, CANONICAL_DESCRIPTOR_SCHEMA, `${target} adapter.json schemaVersion`);
    assert.equal(declared.protocol, CANONICAL_PROTOCOL, `${target} adapter.json protocol`);
    assert.equal(declared.target, target, `${target} adapter.json target`);
    assert.equal(declared.packageName, packageName, `${target} adapter.json packageName`);
    assert.equal(declared.version, "0.0.1", `${target} adapter.json version`);
    assert.deepEqual(declared.actions, CANONICAL_ACTIONS, `${target} adapter.json actions`);
    assert.deepEqual(declared.locations, CANONICAL_LOCATIONS, `${target} adapter.json locations`);

    // The runtime describe response is what the Core runner validates; it must
    // carry the same canonical identity as the static descriptor.
    const { adapter } = await import(path.join(agentsRoot, target, "adapter.mjs"));
    const described = adapter.description;
    assert.equal(described.schemaVersion, CANONICAL_DESCRIPTOR_SCHEMA, `${target} describe schemaVersion`);
    assert.equal(described.protocol, CANONICAL_PROTOCOL, `${target} describe protocol`);
    assert.equal(described.target, target, `${target} describe target`);
    assert.equal(described.packageName, packageName, `${target} describe packageName`);
    assert.equal(described.version, "0.0.1", `${target} describe version`);
    assert.ok(Array.isArray(described.commandNames) && described.commandNames.length > 0, `${target} describe commandNames`);
    assert.ok(CANONICAL_ACTIONS.every((action) => described.actions.includes(action)), `${target} describe actions`);
    assert.deepEqual(described.locations, CANONICAL_LOCATIONS, `${target} describe locations`);
  }
});

test("registry adapter contracts carry the canonical protocol", async () => {
  const registry = JSON.parse(await fs.readFile(path.resolve("plugins", "registry", "plugins.json"), "utf8"));
  const adapters = registry.plugins.filter((entry) => entry.adapter === true);
  assert.deepEqual(adapters.map((entry) => entry.adapterContract?.target).sort(), [...CANONICAL_TARGETS].sort());
  for (const entry of adapters) {
    assert.equal(entry.adapterContract.protocol, CANONICAL_PROTOCOL, `${entry.id} registry protocol`);
  }
});
