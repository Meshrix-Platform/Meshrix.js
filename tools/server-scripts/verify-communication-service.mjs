#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMUNICATION_SERVICE_ID,
  COMMUNICATION_SERVICE_PROTOCOL_VERSION,
  createCommunicationServiceProvider
} from "../../packages/capabilities/src/communication-service/index.mjs";
import {
  MCP_INTERFACE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS } from "../../packages/protocols/downstream-client-aspect/index.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

function serviceById(services, serviceId) {
  const service = services.find((item) => item.serviceId === serviceId);
  assert.ok(service, `${serviceId} must be declared by communication service`);
  return service;
}

async function verifyProvider() {
  const provider = createCommunicationServiceProvider();
  assert.equal(provider.serviceId, COMMUNICATION_SERVICE_ID);
  assert.equal(provider.protocolVersion, COMMUNICATION_SERVICE_PROTOCOL_VERSION);

  const description = provider.describe();
  assert.equal(description.serviceId, COMMUNICATION_SERVICE_ID);
  assert.equal(description.protocolVersion, COMMUNICATION_SERVICE_PROTOCOL_VERSION);
  assert.equal(description.boundary, "platform-capability");
  assert.ok(description.capabilities.includes("communication.services.list"));
  assert.ok(description.capabilities.includes("communication.services.resolve"));

  const services = provider.listServices();
  assert.equal(services.length, 1);

  const mcpServer = serviceById(services, "mcp-server-side");
  assert.equal(mcpServer.label, "MCP Server");
  assert.equal(mcpServer.protocol, "mcp");
  assert.equal(mcpServer.protocolVersion, MCP_INTERFACE_VERSION);
  assert.equal(mcpServer.externalProtocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(mcpServer.routeTarget, DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS.mcp);
  assert.equal(mcpServer.serverName, MCP_SERVER_NAME);
  assert.equal(mcpServer.stableToolName, MCP_STABLE_TOOL_NAME);
  assert.equal(mcpServer.operationBoundary, "v0.0.1:operation-permission:projection-1");
  assert.ok(mcpServer.functions.includes("Operation Permission projection"));

  assert.equal(provider.resolveService({ protocol: "mcp" }).serviceId, "mcp-server-side");
  assert.equal(provider.resolveService({ serviceId: "mcp-server-side" }).protocol, "mcp");
  assert.equal(provider.resolveService({ serviceId: "missing" }), null);
  assert.deepEqual(provider.routeTargetSnapshot(), {
    mcp: DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS.mcp
  });
}

async function verifyModuleManifest() {
  const manifest = await readJson("packages/capabilities/src/communication-service/module.json");
  assert.equal(manifest.protocol, COMMUNICATION_SERVICE_PROTOCOL_VERSION);
  assert.equal(manifest.components.communicationService.factory, "createCommunicationServiceProvider");

  const manifestMcp = serviceById(manifest.services, "mcp-server-side");
  assert.equal(manifestMcp.routeTarget, DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS.mcp);
  assert.equal(manifestMcp.modulePath, "packages/protocols/mcp/adapter/http-mcp-adapter.mjs");
}

async function verifyCoreDoesNotReverseDependOnPlugins() {
  for (const relativePath of [
    "packages/capabilities/src/communication-service/index.mjs",
    "packages/capabilities/src/communication-service/communication-service-provider.mjs",
    "packages/capabilities/src/communication-service/module.json"
  ]) {
    const source = await read(relativePath);
    assert.equal(
      /(?:^|["'`/])plugins\//mu.test(source),
      false,
      `${relativePath} must not import or register a plugin-owned implementation`
    );
  }
}

async function verifyDocs() {
  const html = await read("docs/architecture/ARCHITECTURE.md");
  assert.ok(html.includes("`communication-service`") || html.includes("<code>communication-service</code>"));
  assert.ok(html.includes("**MCP Server**") || html.includes("<strong>MCP Server</strong>"));
  assert.ok(html.includes("mcp-server-side"));

  const architecture = await read("docs/architecture/ARCHITECTURE.md");
  assert.ok(architecture.includes("`communication-service` belongs to the capability layer"));
  assert.ok(architecture.includes("Core communication-service provider does not import or register product implementations"));
}

async function main() {
  await verifyProvider();
  await verifyModuleManifest();
  await verifyCoreDoesNotReverseDependOnPlugins();
  await verifyDocs();
  console.log("[communication-service] ok");
}

await main();
