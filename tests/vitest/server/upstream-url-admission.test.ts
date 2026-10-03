import { describe, expect, it } from "vitest";
import { isUpstreamServiceRemoteUrl } from "../../../packages/contracts/src/upstream-service-publishing.ts";
import {
  normalizeBaseUrl,
  normalizeEndpoint,
  normalizeService
} from "../../../packages/agents/src/upstream-gateway/support.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

const validUrls = [
  ["http://api.example/v1", "http://api.example/v1", "http:", "api.example", "/v1", "80"],
  ["http://api.example:80/v1", "http://api.example/v1", "http:", "api.example", "/v1", "80"],
  ["http://api.example:8080/v1", "http://api.example:8080/v1", "http:", "api.example", "/v1", "8080"],
  ["https://api.example/v1", "https://api.example/v1", "https:", "api.example", "/v1", "443"],
  ["https://api.example:443/v1", "https://api.example/v1", "https:", "api.example", "/v1", "443"],
  ["https://api.example:8443/v1", "https://api.example:8443/v1", "https:", "api.example", "/v1", "8443"],
] as const;

describe("upstream URL admission and runtime normalization", () : any => {
  it.each(validUrls)("admits and stably normalizes %s", (input, expected, protocol, hostname, pathname, effectivePort) : any => {
    expect(isUpstreamServiceRemoteUrl(input)).toBe(true);
    expect(normalizeBaseUrl(input)).toBe(expected);
    expect(normalizeBaseUrl(normalizeBaseUrl(input))).toBe(expected);

    const endpoint = normalizeEndpoint({ endpointId: "primary", baseUrl: input });
    expect(endpoint.baseUrl).toBe(expected);

    const service = normalizeService({
      serviceId: "svc_url_fixture",
      serviceProtocol: "http",
      baseUrl: input,
      operations: [{ operationKey: "read", method: "GET", path: "/v1", payloadTransport: structuredJsonPayloadTransport() }]
    });
    const reloadedService = normalizeService(service);
    expect(reloadedService.baseUrl).toBe(expected);

    const parsed = new URL(reloadedService.baseUrl);
    expect(parsed.protocol).toBe(protocol);
    expect(parsed.hostname).toBe(hostname);
    expect(parsed.pathname).toBe(pathname);
    expect(parsed.port || (parsed.protocol === "http:" ? "80" : "443")).toBe(effectivePort);
  });

  it.each([
    "file:///local/service",
    "https:api.example/v1",
    "https://api.example:65536/v1",
    "https://api.example:not-a-port/v1",
    `https://${["fixture", "placeholder"].join(":")}@api.example/v1`,
  ])("rejects invalid or credential-bearing URL %s at both admission and runtime", (value) : any => {
    expect(isUpstreamServiceRemoteUrl(value)).toBe(false);
    expect(() => normalizeBaseUrl(value)).toThrow();
  });

  it("rejects credentials instead of silently stripping them during endpoint normalization", () : any => {
    const credentialUrl = `https://${["fixture", "placeholder"].join(":")}@api.example/v1`;
    expect(() => normalizeEndpoint({ endpointId: "primary", baseUrl: credentialUrl })).toThrow(/embedded credentials/u);
  });
});
