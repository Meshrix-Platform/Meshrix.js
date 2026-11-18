#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { validateSharedSpaceConfiguration } from "../runtime.mjs";
import { SHARED_SPACE_OPERATION_DEFINITIONS } from "../src/operation-definitions.mjs";

const manifest = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
const configurationSchema = JSON.parse(await readFile(
  new URL("../configuration.schema.json", import.meta.url),
  "utf8"
));
const restoreMachine = JSON.parse(await readFile(
  new URL("../state-machines/checkpoint.restore.json", import.meta.url),
  "utf8"
));

assert.equal(manifest.id, "shared-space");
assert.equal(manifest.defaultEnabled, false);
assert.equal(manifest.runtime.module, "./runtime.mjs");
assert.equal(manifest.operations.length, 21);
assert.equal(manifest.routes.length, 21);
assert.equal(manifest.mcpTools.length, 21);
assert.deepEqual(manifest.consoleEntries, ["workspaces.local-directory"]);
assert.deepEqual(manifest.stateMachines, ["checkpoint.restore"]);
assert.equal(SHARED_SPACE_OPERATION_DEFINITIONS.length, manifest.operations.length);
assert.deepEqual(validateSharedSpaceConfiguration({}), { enabled: false });
assert.deepEqual(validateSharedSpaceConfiguration({
  enabled: true,
  modules: { localDirectory: true, controlledSandbox: true }
}), { enabled: true });
assert.equal(configurationSchema.additionalProperties, false);
assert.equal(restoreMachine.machineId, "checkpoint.restore");
assert.equal(restoreMachine.totalMatrix.length, 81);

const contract = Object.freeze({
  pluginId: manifest.id,
  version: manifest.version,
  operationIds: manifest.operations,
  routeIds: manifest.routes.map((route) => route.id),
  mcpTools: manifest.mcpTools,
  stateMachines: manifest.stateMachines,
  consoleEntries: manifest.consoleEntries,
  hostCapabilities: manifest.hostCapabilities
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  pluginId: contract.pluginId,
  contractDigest: crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex")
})}\n`);
