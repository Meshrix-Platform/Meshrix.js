#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { validateCodingGithubConfiguration } from "../runtime.mjs";
import {
  CODING_GITHUB_OPERATION_DEFINITIONS,
  GITHUB_CODESPACE_OPERATION_IDS,
  GITHUB_MCP_OPERATION_IDS,
  GITHUB_REST_OPERATION_IDS,
  GITHUB_SKILL_INSTALLER_OPERATION_IDS
} from "../src/operation-definitions.mjs";

async function json(relative) {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
}

const [
  manifest,
  configurationSchema,
  restDescriptor,
  mcpDescriptor,
  codespaceCapability,
  skillInstallerCapability,
  lifecycle,
  runtimeSource,
  clientSource
] = await Promise.all([
  json("../plugin.json"),
  json("../configuration.schema.json"),
  json("../external-services/github-rest.external-service.json"),
  json("../external-services/github-mcp.external-service.json"),
  json("../capability/github-codespace-provider.json"),
  json("../capability/skill-installer.json"),
  json("../state-machines/skill-install.lifecycle.json"),
  readFile(new URL("../runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../runtime/external-service-client.mjs", import.meta.url), "utf8")
]);

assert.equal(manifest.id, "coding-github");
assert.equal(manifest.version, "0.0.1");
assert.equal(manifest.defaultEnabled, false);
assert.equal(manifest.contributionMode, "selected");
assert.deepEqual(manifest.hostCapabilities, []);
assert.equal(manifest.runtime.module, "./runtime.mjs");
assert.equal(CODING_GITHUB_OPERATION_DEFINITIONS.length, 24);
assert.equal(GITHUB_REST_OPERATION_IDS.length, 8);
assert.equal(GITHUB_MCP_OPERATION_IDS.length, 2);
assert.equal(GITHUB_CODESPACE_OPERATION_IDS.length, 11);
assert.equal(GITHUB_SKILL_INSTALLER_OPERATION_IDS.length, 3);
assert.deepEqual(manifest.operations, CODING_GITHUB_OPERATION_DEFINITIONS.map((entry) => entry.id));
assert.equal(manifest.routes.length, 24);
assert.equal(manifest.mcpTools.length, 24);
assert.deepEqual(manifest.consoleEntries, ["admin.coding-github"]);
assert.deepEqual(manifest.stateMachines, ["github-skill-install.lifecycle"]);
assert.equal(configurationSchema.additionalProperties, false);
assert.deepEqual(validateCodingGithubConfiguration({}), { enabled: false });

const activeConfiguration = {
  enabled: true,
  modules: { rest: true, mcp: true, codespaces: true, skillInstaller: true },
  services: {
    rest: { serviceRef: "operator-rest-binding", timeoutMs: 30000 },
    mcp: { serviceRef: "operator-mcp-binding", timeoutMs: 60000 }
  }
};
assert.equal(validateCodingGithubConfiguration(activeConfiguration).enabled, true);

const externalOperationIds = new Set([
  ...restDescriptor.tools.map((tool) => tool.operationId),
  ...mcpDescriptor.tools.map((tool) => tool.operationId)
]);
assert.equal(restDescriptor.tools.length, 21);
assert.equal(mcpDescriptor.tools.length, 2);
assert.deepEqual(
  [...externalOperationIds].sort(),
  manifest.operations.filter((id) => id !== "codespace.providers.manifest").sort()
);
assert.deepEqual(mcpDescriptor.tools.map((tool) => tool.operationId), GITHUB_MCP_OPERATION_IDS);
assert.equal(mcpDescriptor.upstreamContract.fixedHeaders["X-MCP-Readonly"], "true");
assert.equal(restDescriptor.healthCheck.type, "none");
assert.deepEqual(codespaceCapability.operations, GITHUB_CODESPACE_OPERATION_IDS);
assert.deepEqual(skillInstallerCapability.operations, GITHUB_SKILL_INSTALLER_OPERATION_IDS);
assert.equal(lifecycle.machineId, "github-skill-install.lifecycle");

for (const descriptor of [restDescriptor, mcpDescriptor]) {
  assert.equal(descriptor.kind, "meshrix.external-service.contract");
  assert.equal(descriptor.serviceSelection.operatorSupplied, true);
  assert.equal(descriptor.upstreamContract.endpoint.operatorSupplied, true);
  assert.equal(descriptor.upstreamContract.credential.custody, "secretRef");
  assert.equal(Object.hasOwn(descriptor, "serviceId"), false);
  assert.equal(Object.hasOwn(descriptor, "binding"), false);
  assert.equal(JSON.stringify(descriptor).includes("https://"), false);
  assert.equal(JSON.stringify(descriptor).includes("secret://"), false);
}
for (const capability of [codespaceCapability, skillInstallerCapability]) {
  assert.equal(capability.credentialContract.source, "operator-published-service");
  assert.equal(capability.providerConfig.operatorSupplied, true);
  assert.equal(Object.hasOwn(capability.providerConfig, "serviceRef"), false);
  assert.equal(Object.hasOwn(capability.providerConfig, "secretRef"), false);
  assert.equal(JSON.stringify(capability).includes("secret://"), false);
}
for (const source of [runtimeSource, clientSource]) {
  assert.doesNotMatch(source, /(?:node:https|node:http|undici|@octokit|\bfetch\s*\()/u);
}

const contract = Object.freeze({
  pluginId: manifest.id,
  version: manifest.version,
  operationIds: manifest.operations,
  routeIds: manifest.routes.map((route) => route.id),
  mcpTools: manifest.mcpTools,
  stateMachines: manifest.stateMachines,
  consoleEntries: manifest.consoleEntries,
  externalOperationIds: [...externalOperationIds].sort()
});
process.stdout.write(`${JSON.stringify({
  ok: true,
  pluginId: manifest.id,
  contractDigest: crypto.createHash("sha256").update(JSON.stringify(contract)).digest("hex")
})}\n`);
