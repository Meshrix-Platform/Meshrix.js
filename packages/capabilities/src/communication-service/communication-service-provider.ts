import {
  MCP_INTERFACE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_STABLE_TOOL_NAME
} from "../../../protocols/mcp/adapter/http-mcp-adapter.ts";

export const COMMUNICATION_SERVICE_PROTOCOL_VERSION: any = "v0.0.1:platform:communication-service-1";
export const COMMUNICATION_SERVICE_ID: any = "communication-service";

function asText(value?: any, fallback: any = "") : any {
  return String(value ?? fallback).trim();
}

function cloneJson(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

const DEFAULT_COMMUNICATION_SERVICES: readonly any[] = Object.freeze([
  Object.freeze({
    serviceId: "mcp-server-side",
    label: "MCP Server",
    kind: "mcp-server-side",
    protocol: "mcp",
    protocolVersion: MCP_INTERFACE_VERSION,
    externalProtocolVersion: MCP_PROTOCOL_VERSION,
    routeTarget: "mcp-server-side",
    capabilityId: "mcp-server-side",
    modulePath: "packages/protocols/mcp/adapter/http-mcp-adapter.ts",
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

function normalizeServiceRecord(record: Record<string, any> = {}) : any {
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
      ? record.calledByAspects.map((value?: any) : any => asText(value)).filter(Boolean)
      : [],
    serverName: asText(record.serverName),
    stableToolName: asText(record.stableToolName),
    functions: Array.isArray(record.functions) ? record.functions.map((value?: any) : any => asText(value)).filter(Boolean) : [],
    operationBoundary: asText(record.operationBoundary)
  });
}

export function createCommunicationServiceProvider({ services = DEFAULT_COMMUNICATION_SERVICES }: Record<string, any> = {}) : any {
  const serviceRecords: any = Object.freeze(services.map((record?: any) : any => normalizeServiceRecord(record)));
  const byServiceId: any = new Map<any, any>(serviceRecords.map((record?: any) : any => [record.serviceId, record]));
  const byRouteTarget: any = new Map<any, any>(serviceRecords.map((record?: any) : any => [record.routeTarget, record]));

  function listServices({ protocol = "", includeInternal = true }: Record<string, any> = {}) : any {
    const normalizedProtocol: any = asText(protocol).toLowerCase();
    return serviceRecords
      .filter((record?: any) : any => !normalizedProtocol || record.protocol === normalizedProtocol)
      .map((record?: any) : any => {
        const cloned: any = cloneJson(record);
        if (!includeInternal) {
          delete cloned.modulePath;
          delete cloned.runtimeBoundary;
        }
        return Object.freeze(cloned);
      });
  }

  function resolveService({ serviceId = "", routeTarget = "", protocol = "" }: Record<string, any> = {}) : any {
    const record: any =
      byServiceId.get(asText(serviceId)) ||
      byRouteTarget.get(asText(routeTarget)) ||
      serviceRecords.find((item?: any) : any => asText(protocol).toLowerCase() && item.protocol === asText(protocol).toLowerCase()) ||
      null;
    return record ? Object.freeze(cloneJson(record)) : null;
  }

  function routeTargetSnapshot() : any {
    return Object.freeze(Object.fromEntries(serviceRecords.map((record?: any) : any => [record.protocol, record.routeTarget])));
  }

  function describe() : any {
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

export const DEFAULT_COMMUNICATION_SERVICE_RECORDS: any = DEFAULT_COMMUNICATION_SERVICES;
