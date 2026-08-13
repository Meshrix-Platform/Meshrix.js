#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import { SKILL_HUB_OPERATION_DEFINITIONS } from "../../plugins/skill-hub/src/operation-definitions.mjs";

const inputSchema = Object.freeze({ type: "object", additionalProperties: true });
const remoteOperations = SKILL_HUB_OPERATION_DEFINITIONS.filter((operation) =>
  !operation.id.startsWith("skill_hub.execution.")
);
const tools = remoteOperations.map((operation) => ({
  operationId: operation.id,
  label: operation.label,
  transport: {
    type: "http",
    method: "POST",
    path: `/v1/operations/${operation.id}`
  },
  requiredScopes: operation.requiredScopes,
  risk: operation.risk,
  inputSchema
}));
const operations = remoteOperations.map((operation) => ({
  operationKey: operation.id,
  label: operation.label,
  protocol: "http",
  method: "POST",
  path: `/v1/operations/${operation.id}`,
  risk: operation.risk,
  requiredScopes: operation.requiredScopes,
  timeoutMs: 120000,
  inputSchema
}));

const contract = {
  schemaVersion: "v0.0.1:schema:definition-1",
  kind: "meshrix.external-service.contract",
  contractId: "skill-hub.external-service",
  displayName: "Skill Hub service contract",
  description: "Closed contract for the independently deployed Skill Hub HTTP service.",
  serviceSelection: {
    configurationPath: "service.serviceRef",
    operatorSupplied: true,
    required: true
  },
  upstreamContract: {
    protocol: "http-json",
    endpoint: { operatorSupplied: true, required: true, allowedSchemes: ["http", "https"] },
    credential: { operatorSupplied: true, required: true, custody: "secretRef", authType: "bearer" },
    timeoutConfigurationPath: "service.timeoutMs",
    eventStream: {
      transport: "sse",
      method: "GET",
      path: "/v1/events",
      cursorHeader: "Last-Event-ID",
      eventType: "skill-hub.catalog.changed"
    }
  },
  authorizationContract: {
    boundary: "Operation Permission v1",
    serviceBindingRequired: true
  },
  tools,
  healthCheck: { type: "http", method: "GET", path: "/readyz" },
  metadata: { pluginId: "skill-hub", deployment: "independent-service-required" }
};

const portable = {
  kind: "meshrix.upstream-service",
  schemaVersion: "v0.0.1:upstream-service:portable-import-2",
  serviceKey: "skill-hub",
  descriptor: {
    serviceProtocol: "http",
    label: "Skill Hub",
    description: "Independent governed skill registry, lifecycle, and package custody service.",
    baseUrl: "http://skill-hub:8080",
    healthPath: "/readyz",
    allowLocalNetwork: true,
    tags: ["skill-hub", "skills"],
    trafficPolicy: { perMinute: 600, burst: 60, maxConcurrent: 16 },
    operations
  }
};

await Promise.all([
  writeFile(new URL("../../plugins/skill-hub/external-services/skill-hub.external-service.json", import.meta.url), `${JSON.stringify(contract, null, 2)}\n`),
  writeFile(new URL("../../docs/examples/skill-hub.upstream.json", import.meta.url), `${JSON.stringify(portable, null, 2)}\n`)
]);
