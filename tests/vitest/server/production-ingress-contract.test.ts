import { describe, expect, it } from "vitest";

import {
  createProductionIngressContract
} from "../../../packages/foundation/src/security/production-ingress-contract.ts";

function request({
  remoteAddress = "192.0.2.10",
  url = "/api/system",
  headers = {}
}: Record<string, any> = {}) : any {
  return {
    url,
    headers,
    socket: { remoteAddress }
  };
}

describe("production ingress contract", () : any => {
  it("keeps the unconfigured runtime local and backward-compatible", () : any => {
    const contract: any = createProductionIngressContract({ mode: "" });
    expect(contract.enabled).toBe(false);
    expect(contract.admit(request())).toMatchObject({ ok: true, source: "direct" });
  });

  it("fails startup preflight for incomplete or unsafe proxy configuration", () : any => {
    expect(() : any => createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "http://console.example.invalid",
      trustedProxies: "192.0.2.10"
    })).toThrowError(expect.objectContaining({
      code: "production_ingress_public_origin_invalid"
    }));
    expect(() : any => createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "https://console.example.invalid",
      trustedProxies: ""
    })).toThrowError(expect.objectContaining({
      code: "production_ingress_trusted_proxies_invalid"
    }));
    expect(() : any => createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "https://console.example.invalid",
      trustedProxies: "192.0.2.10",
      cookieSecure: "never"
    })).toThrowError(expect.objectContaining({
      code: "production_ingress_secure_cookie_required"
    }));
  });

  it("admits only exact HTTPS metadata from an explicitly trusted peer", () : any => {
    const contract: any = createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "https://console.example.invalid",
      trustedProxies: "192.0.2.10"
    });
    expect(contract.admit(request({
      headers: {
        "x-forwarded-for": "198.51.100.7",
        "x-forwarded-host": "console.example.invalid",
        "x-forwarded-port": "443",
        "x-forwarded-proto": "https"
      }
    }))).toMatchObject({ ok: true, source: "trusted-proxy" });
  });

  it("rejects spoofed, ambiguous, or incomplete forwarding metadata", () : any => {
    const contract: any = createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "https://console.example.invalid",
      trustedProxies: "192.0.2.10"
    });
    const validHeaders: Record<string, any> = {
      "x-forwarded-for": "198.51.100.7",
      "x-forwarded-host": "console.example.invalid",
      "x-forwarded-proto": "https"
    };
    expect(contract.admit(request({
      remoteAddress: "192.0.2.11",
      headers: validHeaders
    }))).toMatchObject({
      ok: false,
      status: 403,
      code: "production_ingress_untrusted_peer"
    });
    expect(contract.admit(request({
      headers: {
        ...validHeaders,
        "x-forwarded-proto": "https,http"
      }
    }))).toMatchObject({
      ok: false,
      status: 400,
      code: "production_ingress_forwarding_metadata_invalid"
    });
    expect(contract.admit(request({
      headers: {
        ...validHeaders,
        "x-forwarded-host": "other.example.invalid"
      }
    }))).toMatchObject({
      ok: false,
      status: 400,
      code: "production_ingress_forwarding_metadata_invalid"
    });
  });

  it("keeps only local health probes available without proxy metadata", () : any => {
    const contract: any = createProductionIngressContract({
      mode: "trusted-proxy",
      advertisedBaseUrl: "https://console.example.invalid",
      trustedProxies: "192.0.2.10"
    });
    expect(contract.admit(request({
      remoteAddress: "127.0.0.1",
      url: "/api/healthz"
    }))).toMatchObject({ ok: true, source: "local-probe" });
    expect(contract.admit(request({
      remoteAddress: "127.0.0.1",
      url: "/api/system"
    }))).toMatchObject({
      ok: false,
      code: "production_ingress_untrusted_peer"
    });
  });
});
