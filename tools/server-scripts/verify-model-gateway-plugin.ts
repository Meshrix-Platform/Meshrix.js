#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(root, "plugins", "model-gateway");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"));
const configurationSchema = JSON.parse(fs.readFileSync(path.join(pluginRoot, "configuration.schema.json"), "utf8"));
const runtime = await import(pathToFileURL(path.join(pluginRoot, "runtime.mjs")).href);

assert.equal(manifest.id, "model-gateway");
assert.equal(manifest.defaultEnabled, false);
assert.deepEqual(manifest.operations, ["model_gateway.call", "models.list", "models.get"]);
assert.deepEqual(manifest.routes, []);
assert.deepEqual(manifest.consoleEntries, []);
assert.deepEqual(manifest.hostCapabilities, []);
assert.deepEqual(configurationSchema.required, ["enabled", "serviceRef", "timeoutMs"]);
assert.equal(configurationSchema.additionalProperties, false);

const disabled = await runtime.activatePlugin({ manifest, context: {} });
assert.deepEqual(disabled.contributions.operations, {});
assert.deepEqual(disabled.contributions.routes, {});
assert.deepEqual(disabled.contributions.mcpTools, {});
await disabled.close();

const enabled = await runtime.activatePlugin({
  manifest,
  context: { configuration: { enabled: true, serviceRef: "svc_model", timeoutMs: 30_000 } }
});
assert.deepEqual(Object.keys(enabled.contributions.operations).sort(), ["model_gateway.call", "models.get", "models.list"]);
assert.ok(Object.values(enabled.contributions.operations).every((entry: unknown) =>
  (entry as { definition?: { trafficModel?: unknown } }).definition?.trafficModel === "gateway_transit"));
assert.deepEqual(Object.keys(enabled.contributions.routes), []);
await enabled.close();

process.stdout.write("[model-gateway-plugin] ok\n");
