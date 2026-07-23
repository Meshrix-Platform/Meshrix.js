import {
  MCP_INTERFACE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME
} from "../../../protocols/mcp/adapter/http-mcp-adapter.mjs";

export const COMMUNICATION_SERVICE_PROTOCOL_VERSION = "v0.0.1:platform:communication-service-1";
export const COMMUNICATION_SERVICE_ID = "communication-service";

function asText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const DEFAULT_COMMUNICATION_SERVICES = Object.freeze([
  Object.freeze({
    serviceId: "mcp-server-side",
    label: "MCP Server",
    kind: "mcp-server-side",
    protocol: "mcp",
    protocolVersion: MCP_INTERFACE_VERSION,
    externalProtocolVersion: MCP_PROTOCOL_VERSION,
    routeTarget: "mcp-server-side",
    capabilityId: "mcp-server-side",
    modulePath: "packages/protocols/mcp/adapter/http-mcp-adapter.mjs",
    runtimeBoundary: "platform-capability",
    calledByAspects: ["downstream-client-aspect"],
    serverName: MCP_SERVER_NAME,
    stableToolName: MCP_STABLE_TOOL_NAME,
    functions: [
      "tools/list",
      "tools/call",
      "Operation Permission projection"
    ],
    operationBoundary: "v0.0.1:operation-permission:projection-1"
  })
]);

function normalizeServiceRecord(record = {}) {
  return Object.freeze({
    serviceId: asText(record.serviceId),
    label: asText(record.label || record.serviceId),
    kind: asText(record.kind),
    protocol: asText(record.protocol).toLowerCase(),
    protocolVersion: asText(record.protocolVersion),
    externalProtocolVersion: asText(record.externalProtocolVersion),
    routeTarget: asText(record.routeTarget || record.serviceId),
    capabilityId: asText(record.capabilityId || record.routeTarget || record.serviceId),
    modulePath: asText(record.modulePath),
    runtimeBoundary: asText(record.runtimeBoundary || "platform-capability"),
    calledByAspects: Array.isArray(record.calledByAspects)
      ? record.calledByAspects.map((value) => asText(value)).filter(Boolean)
      : [],
    serverName: asText(record.serverName),
    stableToolName: asText(record.stableToolName),
    functions: Array.isArray(record.functions) ? record.functions.map((value) => asText(value)).filter(Boolean) : [],
    operationBoundary: asText(record.operationBoundary)
  });
}

export function createCommunicationServiceProvider({ services = DEFAULT_COMMUNICATION_SERVICES } = {}) {
  const serviceRecords = Object.freeze(services.map((record) => normalizeServiceRecord(record)));
  const byServiceId = new Map(serviceRecords.map((record) => [record.serviceId, record]));
  const byRouteTarget = new Map(serviceRecords.map((record) => [record.routeTarget, record]));

  function listServices({ protocol = "", includeInternal = true } = {}) {
    const normalizedProtocol = asText(protocol).toLowerCase();
    return serviceRecords
      .filter((record) => !normalizedProtocol || record.protocol === normalizedProtocol)
      .map((record) => {
        const cloned = cloneJson(record);
        if (!includeInternal) {
          delete cloned.modulePath;
          delete cloned.runtimeBoundary;
        }
        return Object.freeze(cloned);
      });
  }

  function resolveService({ serviceId = "", routeTarget = "", protocol = "" } = {}) {
    const record =
      byServiceId.get(asText(serviceId)) ||
      byRouteTarget.get(asText(routeTarget)) ||
      serviceRecords.find((item) => asText(protocol).toLowerCase() && item.protocol === asText(protocol).toLowerCase()) ||
      null;
    return record ? Object.freeze(cloneJson(record)) : null;
  }

  function routeTargetSnapshot() {
    return Object.freeze(Object.fromEntries(serviceRecords.map((record) => [record.protocol, record.routeTarget])));
  }

  function describe() {
    return Object.freeze({
      schemaVersion: "v0.0.1:schema:definition-1",
      serviceId: COMMUNICATION_SERVICE_ID,
      protocolVersion: COMMUNICATION_SERVICE_PROTOCOL_VERSION,
      boundary: "platform-capability",
      capabilities: [
        "communication.services.list",
        "communication.services.resolve",
        "communication.route_targets.snapshot"
      ],
      services: listServices()
    });
  }

  return Object.freeze({
    serviceId: COMMUNICATION_SERVICE_ID,
    protocolVersion: COMMUNICATION_SERVICE_PROTOCOL_VERSION,
    describe,
    listServices,
    resolveService,
    routeTargetSnapshot
  });
}

export const DEFAULT_COMMUNICATION_SERVICE_RECORDS = DEFAULT_COMMUNICATION_SERVICES;
