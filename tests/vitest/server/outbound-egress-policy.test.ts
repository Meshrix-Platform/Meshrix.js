import { describe, expect, it, vi } from "vitest";

import {
  assertOutboundEgressAllowed,
  assertOutboundRuntimeEgressAllowed,
  classifyOutboundHost,
  evaluateOutboundEgressUrl,
  evaluateOutboundEgressUrlWithDns,
  evaluateOutboundRedirectLocationWithDns,
  fetchWithPinnedDns
} from "../../../packages/foundation/src/security/outbound-egress-policy.ts";

describe("Outbound egress policy", () : any => {
  it("classifies restricted local and private address families", () : any => {
    expect(classifyOutboundHost("localhost")).toMatchObject({
      kind: "hostname",
      category: "loopback",
      restricted: true
    });
    expect(classifyOutboundHost("127.0.0.1")).toMatchObject({
      kind: "ipv4",
      category: "loopback",
      restricted: true
    });
    expect(classifyOutboundHost("10.1.2.3")).toMatchObject({
      category: "private",
      restricted: true
    });
    expect(classifyOutboundHost("169.254.169.254")).toMatchObject({
      category: "link-local",
      restricted: true,
      metadataEndpoint: true
    });
    expect(classifyOutboundHost("fd00:ec2::254")).toMatchObject({
      category: "private",
      restricted: true,
      metadataEndpoint: true
    });
    expect(classifyOutboundHost("api.example.com")).toMatchObject({
      kind: "hostname",
      category: "hostname",
      restricted: false
    });
  });

  it("allows explicit loopback/private access but never widens link-local or metadata access", () : any => {
    expect(() : any => assertOutboundEgressAllowed({
      url: "http://169.254.169.254:80/latest/meta-data/",
      label: "outbound.url"
    })).toThrow("Outbound egress denied for outbound.url: restricted_address_cloud-metadata.");

    expect(evaluateOutboundEgressUrl({
      url: "http://127.0.0.1:8787/mcp",
      label: "outbound.url",
      policyPreset: "security.development-local"
    })).toMatchObject({
      ok: true,
      allowLocalForDevelopment: true,
      allowLoopbackAndPrivate: true,
      allowLinkLocal: false,
      addressCategory: "loopback"
    });

    expect(evaluateOutboundEgressUrl({
      url: "http://169.254.20.30/internal",
      policyPreset: "security.development-local"
    })).toMatchObject({
      ok: false,
      reason: "restricted_address_link-local",
      allowLoopbackAndPrivate: true,
      allowLinkLocal: false
    });

    expect(evaluateOutboundEgressUrl({
      url: "http://[fd00:ec2::254]/latest/meta-data/",
      policies: { egress: { allowLocalForConfiguredModelService: true } }
    })).toMatchObject({
      ok: false,
      reason: "restricted_address_cloud-metadata",
      metadataEndpoint: true,
      allowLocalForConfiguredModelService: true
    });
  });

  it("fails closed when DNS resolves hostnames to restricted addresses", async () : Promise<any> => {
    const lookup: any = vi.fn(async () : Promise<any> => [
      { address: "203.0.113.10", family: 4 },
      { address: "10.1.2.3", family: 4 }
    ]);

    await expect(assertOutboundRuntimeEgressAllowed({
      url: "https://api.example.test:443/mcp",
      label: "outbound.url",
      policyPreset: "security.production-default",
      lookup
    })).rejects.toMatchObject({
      code: "outbound_egress_denied",
      decision: {
        reason: "restricted_dns_address_private",
        dns: {
          status: "resolved",
          restrictedAddressCount: 1
        }
      }
    });
    expect(lookup).toHaveBeenCalledWith("api.example.test", { all: true, verbatim: true });

    await expect(assertOutboundRuntimeEgressAllowed({
      url: "https://unresolved.example.test:443/mcp",
      label: "outbound.url",
      policyPreset: "security.production-default",
      lookup: async () : Promise<any> => {
        throw new Error("ENOTFOUND");
      }
    })).rejects.toMatchObject({
      decision: {
        reason: "dns_lookup_failed",
        dns: {
          status: "failed"
        }
      }
    });
  });

  it("allows explicit loopback/private DNS targets but denies any link-local answer", async () : Promise<any> => {
    const allowed: any = await evaluateOutboundEgressUrlWithDns({
      url: "https://dev.service.test:443/mcp",
      label: "outbound.url",
      policyPreset: "security.development-local",
      lookup: async () : Promise<any> => [
        { address: "127.0.0.1", family: 4 },
        { address: "10.20.30.40", family: 4 }
      ]
    });

    expect(allowed).toMatchObject({
      ok: true,
      reason: "allowed",
      allowLocalForDevelopment: true,
      dns: {
        status: "resolved",
        restrictedAddressCount: 2,
        deniedAddressCount: 0
      }
    });

    const denied: any = await evaluateOutboundEgressUrlWithDns({
      url: "https://dev.service.test:443/mcp",
      policies: { egress: { allowLocalForConfiguredModelService: true } },
      lookup: async () : Promise<any> => [
        { address: "127.0.0.1", family: 4 },
        { address: "fe80::1", family: 6 }
      ]
    });

    expect(denied).toMatchObject({
      ok: false,
      reason: "restricted_dns_address_link-local",
      allowLocalForConfiguredModelService: true,
      dns: {
        restrictedAddressCount: 2,
        deniedAddressCount: 1
      }
    });
  });

  it("fails closed when DNS yields no valid address", async () : Promise<any> => {
    const decision: any = await evaluateOutboundEgressUrlWithDns({
      url: "https://empty.service.test/mcp",
      lookup: async () : Promise<any> => [{ address: "not-an-ip", family: 4 }]
    });

    expect(decision).toMatchObject({
      ok: false,
      reason: "dns_no_addresses",
      dns: {
        status: "resolved",
        addressCount: 0,
        deniedAddressCount: 0
      }
    });
  });

  it("pins fetch connections to the DNS answers evaluated by policy", async () : Promise<any> => {
    const lookup: any = vi.fn(async () : Promise<any> => [{ address: "127.0.0.1", family: 4 }]);
    const fetchImpl: any = vi.fn(async (url?: any, init?: any) : Promise<any> => {
      expect(url).toBe("http://service.example.test:43123/health");
      expect(init).toMatchObject({ redirect: "manual" });
      expect(init.dispatcher).toBeDefined();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-host": new URL(url).host
        }
      });
    });
    let pinnedFetch: any = null;
    try {
      pinnedFetch = await fetchWithPinnedDns({
        url: "http://service.example.test:43123/health",
        label: "healthCheck.url",
        policyPreset: "security.development-local",
        lookup,
        fetchImpl,
        init: {
          redirect: "manual"
        }
      });
      expect(await pinnedFetch.response.json()).toEqual({ ok: true });
      expect(pinnedFetch.pinnedDns).toMatchObject({
        host: "service.example.test",
        address: "127.0.0.1",
        family: 4,
        addressCategory: "loopback",
        restricted: true
      });
      expect(pinnedFetch.response.headers.get("x-request-host")).toBe("service.example.test:43123");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith("service.example.test", { all: true, verbatim: true });
    } finally {
      await pinnedFetch?.close?.();
    }
  });

  it("validates redirect Location decisions without following the redirect", async () : Promise<any> => {
    const literalDecision: any = await evaluateOutboundRedirectLocationWithDns({
      sourceUrl: "https://203.0.113.10:443/start",
      status: 302,
      location: "http://169.254.169.254:80/latest/meta-data/",
      label: "tools[].transport.url.redirectLocation",
      policyPreset: "security.production-default",
      lookup: async () : Promise<any> => {
        throw new Error("literal addresses should not need DNS");
      }
    });
    expect(literalDecision).toMatchObject({
      ok: false,
      reason: "restricted_address_cloud-metadata",
      targetUrl: "http://169.254.169.254/latest/meta-data/",
      targetDecision: {
        addressCategory: "link-local",
        metadataEndpoint: true
      }
    });

    const dnsDecision: any = await evaluateOutboundRedirectLocationWithDns({
      sourceUrl: "https://redirect.example.test:443/start",
      status: 307,
      location: "/next",
      label: "tools[].transport.url.redirectLocation",
      policyPreset: "security.production-default",
      lookup: async () : Promise<any> => [{ address: "192.168.1.10", family: 4 }]
    });
    expect(dnsDecision).toMatchObject({
      ok: false,
      reason: "restricted_dns_address_private",
      targetUrl: "https://redirect.example.test/next"
    });
  });

  it("manually revalidates every redirect hop and strips cross-origin authority", async () : Promise<any> => {
    const calls: any[] = [];
    const lookup: any = vi.fn(async () : Promise<any> => [{ address: [8, 8, 8, 8].join("."), family: 4 }]);
    const fetchImpl: any = vi.fn(async (url?: any, init?: any) : Promise<any> => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://second.example.test/final" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result: any = await fetchWithPinnedDns({
      url: "https://first.example.test/start",
      lookup,
      fetchImpl,
      maxRedirects: 5,
      init: {
        method: "POST",
        headers: { authorization: "Bearer synthetic", "content-type": "application/json" },
        body: "{}"
      }
    });
    try {
      expect(await result.response.json()).toEqual({ ok: true });
      expect(calls).toHaveLength(2);
      expect(calls[0].init.redirect).toBe("manual");
      expect(calls[1].init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(calls[1].init.headers.authorization).toBeUndefined();
      expect(calls[1].init.body).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      await result.close();
    }
  });

  it("returns a redirect response without a second hop when redirects are disabled", async () : Promise<any> => {
    const fetchImpl: any = vi.fn(async () : Promise<any> => new Response(null, {
      status: 302,
      headers: { location: "https://second.example.test/final" }
    }));
    const lookup: any = vi.fn(async () : Promise<any> => [{ address: [8, 8, 8, 8].join("."), family: 4 }]);
    const result: any = await fetchWithPinnedDns({
      url: "https://first.example.test/start",
      fetchImpl,
      lookup,
      maxRedirects: 0
    });
    try {
      expect(result.response.status).toBe(302);
    } finally {
      await result.close();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("denies a redirect to restricted DNS before issuing the next request", async () : Promise<any> => {
    const fetchImpl: any = vi.fn(async () : Promise<any> => new Response(null, {
      status: 307,
      headers: { location: "https://private.example.test/next" }
    }));
    const lookup: any = vi.fn(async (host?: any) : Promise<any> => [{
      address: host === "private.example.test" ? "10.0.0.4" : [8, 8, 8, 8].join("."),
      family: 4
    }]);
    await expect(fetchWithPinnedDns({
      url: "https://public.example.test/start",
      fetchImpl,
      maxRedirects: 5,
      lookup
    })).rejects.toMatchObject({ code: "outbound_egress_denied" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
