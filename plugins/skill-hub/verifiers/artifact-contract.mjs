#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import {
  activatePlugin,
  validateSkillHubConfiguration
} from "../runtime.mjs";
import { createSkillHubExternalServiceClient } from "../runtime/external-service-client.mjs";
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
  service: { serviceRef: "operator-skill-hub-service" }
}), { enabled: true, serviceRef: "operator-skill-hub-service" });
assert.throws(() => validateSkillHubConfiguration({
  enabled: true,
  service: { serviceRef: "operator-skill-hub-service", unexpected: true }
}));
assert.match(consoleSource, /export function mountPluginConsole/u);

const disabled = await activatePlugin({ manifest, context: { configuration: {} } });
assert.equal(Object.values(disabled.contributions).flatMap((value) => Object.keys(value)).length, 0);
await disabled.close();

const enabled = await activatePlugin({
  manifest,
  context: {
    configuration: {
      enabled: true,
      service: { serviceRef: "operator-skill-hub-service" }
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

const invocationPlugin = await activatePlugin({
  manifest,
  context: {
    configuration: {
      enabled: true,
      service: { serviceRef: "operator-skill-hub-service" }
    }
  }
});
const invocationRequests = [];
const invocationCall = {
  auth: { authenticated: true },
  governance: { authorized: true, current: true }
};
const invocationHost = {
  externalService: { request: async (request) => {
    invocationRequests.push(request);
    return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
  } }
};
for (let index = 0; index < 2; index += 1) {
  await invocationPlugin.contributions.operations["skill_hub.list"].execute({
    input: { filter: "same-content" },
    call: invocationCall,
    host: invocationHost
  });
}
assert.notEqual(
  invocationRequests[0].idempotencyKey,
  invocationRequests[1].idempotencyKey,
  "separate same-content executions receive separate logical invocation keys"
);
await invocationPlugin.close();

const forwarded = [];
const requestSignal = new AbortController().signal;
const remote = createSkillHubExternalServiceClient({ serviceRef: "operator-skill-hub-service" });
await remote.request({
  operation: { id: "skill_hub.list" },
  input: {},
  signal: requestSignal,
  host: {
    externalService: { request: async (request, options) => {
      forwarded.push({ request, options });
      return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
    } }
  }
});
assert.equal(forwarded.length, 1);
assert.deepEqual(Object.keys(forwarded[0].request).sort(), ["idempotencyKey", "input", "operationRef", "serviceRef"]);
assert.equal(forwarded[0].options.signal, requestSignal);
const firstGeneratedKey = forwarded[0].request.idempotencyKey;
await remote.request({
  operation: { id: "skill_hub.list" },
  input: {},
  host: { externalService: { request: async (request) => {
    forwarded.push({ request, options: {} });
    return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
  } } }
});
assert.notEqual(forwarded.at(-1).request.idempotencyKey, firstGeneratedKey,
  "standalone requests without caller identity receive fresh invocation keys");

const logicalInvocationId = "synthetic-logical-invocation";
for (const phase of ["prepare", "commit"]) {
  await remote.request({
    operation: { id: "skill_hub.execute" },
    input: {},
    invocationId: logicalInvocationId,
    phase,
    host: { externalService: { request: async (request) => {
      forwarded.push({ request, options: {} });
      return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
    } } }
  });
}
for (const phase of ["prepare", "commit"]) {
  const expected = `skill-hub:${crypto.createHash("sha256").update(JSON.stringify({
    invocationId: logicalInvocationId,
    operationId: "skill_hub.execute",
    phase
  })).digest("hex")}`;
  assert.equal(forwarded.findLast((entry) => entry.request.operationRef === "skill_hub.execute" &&
    entry.request.idempotencyKey === expected)?.request.idempotencyKey, expected,
  "phase-specific keys retain the same logical invocation identity");
}

const explicitKey = "stable-sandbox-run-key";
await remote.request({
  operation: { id: "skill_hub.execute" },
  input: { idempotencyKey: explicitKey, args: ["first"] },
  host: { externalService: { request: async (request) => {
    forwarded.push({ request, options: {} });
    return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
  } } }
});
const explicitKeyRequest = forwarded.at(-1).request;
const expectedKey = `skill-hub:${crypto.createHash("sha256").update(JSON.stringify({
  callerKey: explicitKey,
  operationId: "skill_hub.execute",
  phase: "execute"
})).digest("hex")}`;
assert.equal(explicitKeyRequest.idempotencyKey, expectedKey);
await remote.request({
  operation: { id: "skill_hub.execute" },
  input: { idempotencyKey: explicitKey, args: ["changed"] },
  host: { externalService: { request: async (request) => {
    forwarded.push({ request, options: {} });
    return { ok: true, status: 200, data: { statusCode: 200, body: { ok: true } } };
  } } }
});
assert.equal(forwarded.at(-1).request.idempotencyKey, expectedKey,
  "caller-owned idempotency identity is stable when non-key request fields change");
await remote.close();

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
