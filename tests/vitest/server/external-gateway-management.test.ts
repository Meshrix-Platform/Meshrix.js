import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createExternalGatewayAuthority,
  normalizeExternalGatewayProfile,
  renderExternalGatewayConfig,
} from "../../../packages/agents/src/agent-gateway/external-gateway/index.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { executeRuntimeMountOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts";
import { createExternalGatewayManagementProvider } from "../../../packages/server-runtime/src/composition/external-gateway-management-provider.ts";
import { probeExternalGatewayEndpoint } from "../../../packages/server-runtime/src/composition/external-gateway-endpoint-probe.ts";
import { signMcpHandshake } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-identity.ts";
import { mcpHandshake } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-discovery.ts";
import { MCP_PROTOCOL_VERSION } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";

function createProbeIdentity() : any {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: "ed25519:external-gateway-test",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    privateKeyJwk: privateKey.export({ format: "jwk" }),
  };
}

function jsonResponse(payload?: any, { status = 200, headers = {} }: Record<string, any> = {}) : any {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createProbeFetch({ identity, adapterId = "caddy", mcpOk = true }: Record<string, any> = {}) : any {
  return vi.fn(async (url?: any, options: Record<string, any> = {}) : Promise<any> => {
    const parsed: any = new URL(url);
    if (parsed.pathname === "/api/healthz") return jsonResponse({ ok: true });
    if (parsed.pathname === "/api/mcp/handshake") {
      const nonce: any = JSON.parse(options.body).nonce;
      const payload: Record<string, any> = {
        schemaVersion: "v0.0.1:mcp:handshake-1",
        nonce,
        identity: {
          algorithm: "Ed25519",
          keyId: identity.keyId,
          publicKeyJwk: identity.publicKeyJwk,
        },
        server: { name: "Meshrix.js" },
        externalGateway: {
          adapterId,
          route: "/api/mcp/handshake",
          requestIdPresent: true,
        },
      };
      return jsonResponse({ ok: true, payload, signature: signMcpHandshake({ identity, payload }) });
    }
    if (parsed.pathname === "/mcp" && options.method === "POST") {
      return jsonResponse(mcpOk ? {
        jsonrpc: "2.0",
        id: "external-gateway-probe",
        result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "Meshrix.js" } },
      } : { error: "not mcp" }, { headers: { "Mcp-Session-Id": "probe-session" } });
    }
    if (parsed.pathname === "/mcp" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({}, { status: 404 });
  });
}

describe("External Gateway management provider", () : any => {
  it("normalizes one default policy and renders capability-valid Caddy and Nginx configs", () : any => {
    const profile: any = normalizeExternalGatewayProfile({
      mode: "external",
      adapterId: "caddy",
      publicBaseUrl: "https://gateway.example.invalid:8443/",
    });

    expect(profile.trafficPolicyOwner).toBe("external");
    expect(profile.platformGovernanceRequired).toBe(true);
    expect(profile.delegatedControls).toEqual([
      "load-balancing",
      "general-rate-limit",
      "endpoint-health",
      "replay-safe-edge-retry",
    ]);
    expect(profile.platformControls).toEqual(expect.arrayContaining([
      "authentication",
      "operation-permission",
      "approval",
      "business-quota",
      "resource-ceilings",
      "cancellation",
    ]));
    expect(profile.delegatedControls.filter((control?: any) : any => profile.platformControls.includes(control))).toEqual([]);
    expect(profile.directMode.mustWorkWithoutGateway).toBe(true);
    expect(profile.gatewayMode.publicBaseUrl).toBe("https://gateway.example.invalid:8443");
    expect(profile.routes.find((route?: any) : any => route.routeId === "mcp-stream")).toMatchObject({
      streaming: true,
      sticky: true,
    });

    const caddy: any = renderExternalGatewayConfig({ ...profile, adapterId: "caddy" });
    const nginx: any = renderExternalGatewayConfig({ ...profile, adapterId: "nginx" });
    expect(caddy.config).toContain("flush_interval -1");
    expect(caddy.config).toContain("rate_limit");
    expect(caddy.config).toContain("header_up -X-Forwarded-For");
    expect(nginx.config).toContain("proxy_buffering off");
    expect(nginx.config).toContain("limit_req_zone");
    expect(nginx.config).toContain("least_conn");
    expect(nginx.config).toContain("Mcp-Session-Id");
    expect(caddy.capabilities).toContain("mcp-streaming");
    expect(nginx.capabilities).toContain("validated-reload");
  });

  it("atomically activates one generation and preserves it on validation failure", async () : Promise<any> => {
    const persist: any = vi.fn(async () : Promise<any> => {});
    const authority: any = createExternalGatewayAuthority({
      persist,
      validateRuntime: async ({ profile }: Record<string, any>) : Promise<any> => profile.adapterId === "caddy"
        ? { ok: true }
        : { ok: false, reason: "adapter_validation_failed" },
      probe: async () : Promise<any> => ({ ok: true }),
    });
    const provider: any = createExternalGatewayManagementProvider({ externalGateway: authority });

    expect(provider.getState()).toEqual({ mode: "direct", generation: 0 });
    expect(provider.listAdapters().map((adapter?: any) : any => adapter.adapterId)).toEqual(["caddy", "nginx"]);

    await expect(provider.apply({
      expectedGeneration: 0,
      mode: "external",
      adapterId: "caddy",
      publicBaseUrl: "https://gateway.example.invalid:8443",
    }))
      .resolves.toMatchObject({ ok: true, mode: "external", adapterId: "caddy", generation: 1 });
    await expect(provider.apply({
      expectedGeneration: 1,
      mode: "external",
      adapterId: "nginx",
      publicBaseUrl: "https://gateway.example.invalid:8443",
    }))
      .resolves.toMatchObject({ ok: false, reason: "adapter_validation_failed", generation: 1 });
    expect(provider.getState()).toMatchObject({
      mode: "external",
      adapterId: "caddy",
      generation: 1,
      profile: { gatewayMode: { publicBaseUrl: "https://gateway.example.invalid:8443" } },
    });
    await expect(provider.apply({ expectedGeneration: 0, mode: "external", adapterId: "caddy" }))
      .resolves.toMatchObject({ ok: false, reason: "external_gateway_generation_conflict", generation: 1 });
    await expect(provider.switchDirect({ expectedGeneration: 1 }))
      .resolves.toMatchObject({ ok: true, mode: "direct", generation: 2 });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit endpoint and preserves the generation when the live probe fails", async () : Promise<any> => {
    const persist: any = vi.fn(async () : Promise<any> => {});
    const authority: any = createExternalGatewayAuthority({
      persist,
      probe: async () : Promise<any> => ({ ok: false, reason: "external_gateway_health_probe_failed" }),
    });

    await expect(authority.apply({ expectedGeneration: 0, mode: "external", adapterId: "caddy" }))
      .resolves.toEqual({ ok: false, reason: "external_gateway_public_url_required", generation: 0 });
    await expect(authority.apply({
      expectedGeneration: 0,
      mode: "external",
      adapterId: "caddy",
      publicBaseUrl: "https://gateway.example.invalid",
    })).resolves.toEqual({ ok: false, reason: "external_gateway_health_probe_failed", generation: 0 });
    expect(authority.getState()).toEqual({ mode: "direct", generation: 0 });
    expect(persist).not.toHaveBeenCalled();
  });

  it("fails closed when no live endpoint probe is composed", async () : Promise<any> => {
    const authority: any = createExternalGatewayAuthority();
    await expect(authority.apply({
      expectedGeneration: 0,
      mode: "external",
      adapterId: "caddy",
      publicBaseUrl: "https://gateway.example.invalid",
    })).resolves.toEqual({ ok: false, reason: "external_gateway_probe_unavailable", generation: 0 });
    expect(authority.getState()).toEqual({ mode: "direct", generation: 0 });
  });

  it.each(["caddy", "nginx"])("passes only after %s health, signed transit, and MCP probes", async (adapterId?: any) : Promise<any> => {
    const identity: any = createProbeIdentity();
    const fetchImpl: any = createProbeFetch({ identity, adapterId });
    const profile: any = normalizeExternalGatewayProfile({
      mode: "external",
      adapterId,
      publicBaseUrl: "https://gateway.example.invalid",
    });

    await expect(probeExternalGatewayEndpoint({ profile, expectedIdentity: identity, fetchImpl }))
      .resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls.map(([url, options]: any[]) : any => [new URL(url).pathname, options?.method || "GET"]))
      .toEqual([
        ["/api/healthz", "GET"],
        ["/api/mcp/handshake", "POST"],
        ["/mcp", "POST"],
        ["/mcp", "DELETE"],
      ]);
    expect(fetchImpl.mock.calls.every(([, options]: any[]) : any => options.redirect === "error")).toBe(true);
    expect(fetchImpl.mock.calls.every(([, options]: any[]) : any => options.credentials === "omit")).toBe(true);
  });

  it("rejects wrong adapter evidence and an invalid MCP endpoint", async () : Promise<any> => {
    const identity: any = createProbeIdentity();
    const profile: any = normalizeExternalGatewayProfile({
      mode: "external",
      adapterId: "caddy",
      publicBaseUrl: "https://gateway.example.invalid",
    });

    await expect(probeExternalGatewayEndpoint({
      profile,
      expectedIdentity: identity,
      fetchImpl: createProbeFetch({ identity, adapterId: "nginx" }),
    })).resolves.toEqual({ ok: false, reason: "external_gateway_adapter_probe_failed" });
    await expect(probeExternalGatewayEndpoint({
      profile,
      expectedIdentity: identity,
      fetchImpl: createProbeFetch({ identity, adapterId: "caddy", mcpOk: false }),
    })).resolves.toEqual({ ok: false, reason: "external_gateway_mcp_probe_failed" });
  });

  it("signs bounded gateway transit evidence into the platform handshake", () : any => {
    const identity: any = createProbeIdentity();
    const result: any = mcpHandshake({
      request: {
        headers: {
          "x-meshrix-gateway": "caddy",
          "x-meshrix-gateway-route": "/api/mcp/handshake",
          "x-meshrix-gateway-request-id": "request-id",
        },
      },
      requestBody: Buffer.from(JSON.stringify({ nonce: "a".repeat(32) })),
      listenUrl: "http://127.0.0.1:7228",
      discoveryState: {
        mcpIdentity: identity,
        serverId: identity.keyId,
      },
    });
    expect(result.body.payload.externalGateway).toEqual({
      adapterId: "caddy",
      route: "/api/mcp/handshake",
      requestIdPresent: true,
    });
  });

  it("registers and executes the bounded External Gateway management operations", async () : Promise<any> => {
    const operationIds: any = new Set<any>(SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id));
    for (const operationId of [
      "runtime.external_gateway",
      "runtime.external_gateway.validate",
      "runtime.external_gateway.apply",
      "runtime.external_gateway.switch_direct",
    ]) {
      expect(operationIds.has(operationId)).toBe(true);
    }

    const externalGatewayManagement: Record<string, any> = {
      getState: vi.fn(() : any => ({ mode: "direct", generation: 0 })),
      validate: vi.fn(async () : Promise<any> => ({ ok: true })),
      apply: vi.fn(async () : Promise<any> => ({ ok: true, mode: "external", generation: 1 })),
      switchDirect: vi.fn(async () : Promise<any> => ({ ok: true, mode: "direct", generation: 2 })),
    };
    const context: Record<string, any> = { externalGatewayManagement };

    await expect(executeRuntimeMountOperation({
      operationId: "runtime.external_gateway",
      context,
    })).resolves.toMatchObject({ status: 200, payload: { mode: "direct", generation: 0 } });
    await expect(executeRuntimeMountOperation({
      operationId: "runtime.external_gateway.apply",
      input: { expectedGeneration: 0, adapterId: "caddy" },
      context,
    })).resolves.toMatchObject({ status: 200, payload: { ok: true, mode: "external", generation: 1 } });
  });
});
