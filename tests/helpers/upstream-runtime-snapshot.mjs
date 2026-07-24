import { fingerprint } from "../../packages/agents/src/upstream-gateway/manifest-compiler.mjs";
import { normalizeService } from "../../packages/agents/src/upstream-gateway/support.mjs";

export function structuredJsonPayloadTransport({
  requestMaxBytes = 1024 * 1024,
  responseMaxBytes = 1024 * 1024
} = {}) {
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

export function structuredUpstreamServiceFixture(rawService = {}) {
  return {
    ...rawService,
    operations: (rawService.operations || []).map((operation) => ({
      ...operation,
      payloadTransport: operation.payloadTransport || structuredJsonPayloadTransport()
    }))
  };
}

export function installUpstreamRuntimeServices(registry, rawServices = []) {
  const services = new Map(rawServices.map((rawService, index) => {
    const normalized = normalizeService(rawService, {});
    const service = Object.freeze({
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
      [...services.entries()].map(([serviceId, service]) => Object.freeze([serviceId, service]))
    )
  }));
}
