#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import {
  activatePlugin,
  validateSkillHubConfiguration
} from "../runtime.mjs";
import { SKILL_HUB_OPERATION_DEFINITIONS } from "../src/operation-definitions.mjs";

const pluginRoot = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("plugin.json", pluginRoot), "utf8"));
const configurationSchema = JSON.parse(await readFile(
  new URL("configuration.schema.json", pluginRoot),
  "utf8"
));
const consoleSource = await readFile(new URL("console/index.mjs", pluginRoot), "utf8");

async function relativeInventory(directory = pluginRoot, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) output.push(...await relativeInventory(new URL(`${entry.name}/`, directory), `${relative}/`));
    else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}

assert.equal(manifest.id, "skill-hub");
assert.equal(manifest.defaultEnabled, false);
assert.deepEqual(manifest.dependencies, []);
assert.deepEqual(manifest.hostCapabilities, []);
assert.equal(manifest.runtime.module, "./runtime.mjs");
assert.equal(manifest.operations.length, 20);
assert.equal(manifest.routes.length, 20);
assert.equal(manifest.mcpTools.length, 20);
assert.deepEqual(manifest.consoleEntries, ["admin.skill-hub"]);
assert.deepEqual(manifest.stateMachines, []);
assert.deepEqual(
  manifest.operations,
  SKILL_HUB_OPERATION_DEFINITIONS.map((definition) => definition.id)
);
assert.deepEqual(
  new Set(manifest.routes.map((route) => route.id)),
  new Set(SKILL_HUB_OPERATION_DEFINITIONS.map((definition) => `${definition.id}.http`))
);
assert.deepEqual(
  new Set(manifest.mcpTools),
  new Set(SKILL_HUB_OPERATION_DEFINITIONS.map((definition) =>
    definition.id.replace(/^skill_hub/u, "meshrix.skillHub")
  ))
);
assert.equal(configurationSchema.additionalProperties, false);
assert.deepEqual(validateSkillHubConfiguration({}), { enabled: false });
assert.deepEqual(validateSkillHubConfiguration({
  enabled: true,
  service: { serviceRef: "operator-skill-hub-service", timeoutMs: 30000 }
}), { enabled: true, serviceRef: "operator-skill-hub-service", timeoutMs: 30000 });
assert.match(consoleSource, /export function mountPluginConsole/u);

const disabled = await activatePlugin({ manifest, context: { configuration: {} } });
assert.equal(Object.values(disabled.contributions).flatMap((value) => Object.keys(value)).length, 0);
await disabled.close();

const enabled = await activatePlugin({
  manifest,
  context: {
    configuration: {
      enabled: true,
      service: { serviceRef: "operator-skill-hub-service", timeoutMs: 30000 }
    }
  }
});
assert.equal(Object.keys(enabled.contributions.operations).length, 20);
assert.equal(Object.keys(enabled.contributions.routes).length, 20);
assert.equal(Object.keys(enabled.contributions.mcpTools).length, 20);
assert.deepEqual(enabled.contributions.stateMachines, {});
assert.deepEqual(
  enabled.contributions.operations["skill_hub.permission.grant"].requiredHostPorts,
  ["externalService", "operationPermissionGrant"]
);
assert.ok(Object.values(enabled.contributions.operations).every((operation) =>
  operation.requiredHostPorts.includes("externalService") ||
  operation.definition.id.startsWith("skill_hub.execution.")
));
assert.ok(Object.values(enabled.contributions.operations).every((operation) =>
  !operation.requiredHostPorts.includes("pluginData") &&
  !operation.requiredHostPorts.includes("opaqueArtifactCustody") &&
  !operation.requiredHostPorts.includes("securityPermissions") &&
  !operation.requiredHostPorts.includes("operationPermissionPlatform")
));
await enabled.close();

const inventory = await relativeInventory();
assert.ok(inventory.includes("runtime.mjs"));
assert.ok(inventory.includes("configuration.schema.json"));
assert.ok(inventory.includes("console/index.mjs"));
assert.ok(inventory.includes("external-services/skill-hub.external-service.json"));
assert.ok(inventory.every((file) => !/\.(?:vue|ts|tsx)$/u.test(file)));

const contract = Object.freeze({
  pluginId: manifest.id,
  version: manifest.version,
  operationIds: manifest.operations,
  routeIds: manifest.routes.map((route) => route.id),
  mcpTools: manifest.mcpTools,
  consoleEntries: manifest.consoleEntries,
  stateMachines: manifest.stateMachines,
  storageBoundary: "independent-service-only",
  serviceBinding: "service.serviceRef",
  operationPermissionWritePort: "operationPermissionGrant.recordPluginGrant"
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  pluginId: contract.pluginId,
  fileCount: inventory.length,
  operationCount: contract.operationIds.length,
  contractDigest: crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex")
})}\n`);
