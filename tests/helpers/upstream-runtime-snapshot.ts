import { fingerprint } from "../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import { normalizeService } from "../../packages/agents/src/upstream-gateway/support.ts";

export function structuredJsonPayloadTransport({
  requestMaxBytes = 1024 * 1024,
  responseMaxBytes = 1024 * 1024
}: Record<string, any> = {}) : any {
  return {
    request: {
      mode: "structured_json",
      maxBytes: requestMaxBytes,
      mediaTypes: ["application/json"]
    },
    response: {
      mode: "structured_json",
      maxBytes: responseMaxBytes,
      mediaTypes: ["application/json"]
    }
  };
}

export function structuredUpstreamServiceFixture(rawService: Record<string, any> = {}) : any {
  return {
    ...rawService,
    operations: (rawService.operations || []).map((operation?: any) : any => ({
      ...operation,
      payloadTransport: operation.payloadTransport || structuredJsonPayloadTransport()
    }))
  };
}

export function installUpstreamRuntimeServices(registry?: any, rawServices: any = []) : any {
  const services: any = new Map<any, any>(rawServices.map((rawService?: any, index?: any) : any => {
    const normalized: any = normalizeService(rawService, {});
    const service: Readonly<Record<string, any>> = Object.freeze({
      ...normalized,
      manifestDigest: fingerprint(rawService),
      serviceRevision: index + 1
    });
    return [service.serviceId, service];
  }));
  return registry.replaceFromManifestSnapshot(Object.freeze({
    setRevision: 1,
    setDigest: fingerprint(rawServices),
    serviceEntries: Object.freeze(
      [...services.entries()].map(([serviceId, service]: any[]) : any => Object.freeze([serviceId, service]))
    )
  }));
}
