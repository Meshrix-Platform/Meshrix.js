import fs from "node:fs/promises";
import http from "node:http";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUpstreamGatewayRegistry
} from "../../../packages/agents/src/upstream-gateway/index.mjs";
import {
  installUpstreamRuntimeServices,
  structuredJsonPayloadTransport,
  structuredUpstreamServiceFixture
} from "../../helpers/upstream-runtime-snapshot.mjs";
import {
  initializeLocalSecret
} from "../../../packages/foundation/src/security/secrets/local-secret-store.mjs";

const SECRET_REF = "secret://upstream-gateway/security-test";
const RESOLVED_SECRET_TOKEN = "resolved-upstream-secret-token-must-not-leak";

const subject = {
  subjectId: "upstream-gateway-security-test",
  scopes: ["gateway:read", "gateway:write"]
};

const cleanupTasks = [];

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function startFixtureServer() {
  const hits = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => request.on("end", resolve));
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const body = Buffer.concat(chunks).toString("utf8");
    hits.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      headers: request.headers,
      body
    });
    if (url.pathname === "/api/redirect-cross-origin") {
      response.writeHead(302, {
        Location: url.searchParams.get("to") || "/api/fallback",
        "Cache-Control": "no-store"
      });
      response.end("");
      return;
    }
    sendJson(response, 200, {
      ok: true,
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      body: body ? JSON.parse(body) : null,
      allowedHeader: request.headers["x-request-id"] || "",
      credentialOk: request.headers.authorization === `Bearer ${RESOLVED_SECRET_TOKEN}`
    });
  });
  await listenLoopback(server);
  cleanupTasks.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    hits,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function createRegistry(services) {
  const { registry } = await createRegistryWithDataDir(services);
  return registry;
}

async function createRegistryWithDataDir(services, options = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-gateway-ssrf-"));
  cleanupTasks.push(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const registry = createUpstreamGatewayRegistry({ userDataPath, ...options });
  installUpstreamRuntimeServices(
    registry,
    services.map((service) => structuredUpstreamServiceFixture({ allowLocalNetwork: true, ...service }))
  );
  cleanupTasks.push(() => registry.close());
  return {
    userDataPath,
    registry
  };
}

async function writeLocalSecret({ userDataPath, serviceId, baseUrl }) {
  const endpoint = new URL(baseUrl);
  await initializeLocalSecret({
    dataDir: userDataPath,
    target: {
      provider: "upstream-gateway-test",
      family: "upstream-gateway",
      authType: "bearer",
      secretRef: SECRET_REF,
      scope: {
        serviceId,
        allowedHosts: [endpoint.hostname],
        allowedProtocols: [endpoint.protocol.replace(/:$/, "")],
        scopes: ["gateway:read", "gateway:write"]
      }
    },
    payload: {
      token: RESOLVED_SECRET_TOKEN
    }
  });
}

function createStaticTagStore(projections = []) {
  return {
    listProjections({ entityType = "" } = {}) {
      return projections.filter((projection) => !entityType || projection.entityType === entityType);
    },
    getTag(tagId = "") {
      return tagId ? { tagId, status: "active", enabled: true } : null;
    },
    getPolicyRevision() {
      return {
        protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    }
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (cleanupTasks.length) {
    const cleanup = cleanupTasks.pop();
    await cleanup();
  }
});

describe("upstream gateway SSRF boundary", () => {
  it("requires an explicit service policy before reaching a restricted local target", async () => {
    const fixture = await startFixtureServer();
    const registry = await createRegistry([{
      serviceId: "local-denied",
      baseUrl: fixture.baseUrl,
      allowLocalNetwork: false,
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/fixed",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    await expect(registry.forward({
      serviceId: "local-denied",
      operationKey: "read"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "outbound_egress_denied"
    });
    expect(fixture.hits).toHaveLength(0);
  });

  it("keeps link-local and cloud metadata targets denied when local network access is enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = await createRegistry([{
      serviceId: "metadata-denied",
      baseUrl: "http://169.254.169.254:80",
      allowLocalNetwork: true,
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/latest/meta-data/",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    await expect(registry.forward({
      serviceId: "metadata-denied",
      operationKey: "read"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "outbound_egress_denied",
      decision: {
        reason: "restricted_address_cloud-metadata",
        allowLocalForConfiguredModelService: true,
        allowLinkLocal: false
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a link-local DNS answer before opening an opted-in local connection", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{
      address: "169.254.20.30",
      family: 4
    }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = await createRegistry([{
      serviceId: "link-local-dns-denied",
      baseUrl: "http://service.internal.test:80",
      allowLocalNetwork: true,
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/internal",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    await expect(registry.forward({
      serviceId: "link-local-dns-denied",
      operationKey: "read"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "outbound_egress_denied",
      decision: {
        reason: "restricted_dns_address_link-local"
      }
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the preflight DNS result for the configured request", async () => {
    const fixture = await startFixtureServer();
    const fixturePort = new URL(fixture.baseUrl).port;
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{
      address: "127.0.0.1",
      family: 4
    }]);
    const registry = await createRegistry([{
      serviceId: "dns-pinned",
      baseUrl: `http://rebind.example.test:${fixturePort}`,
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/fixed",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    await expect(registry.forward({
      serviceId: "dns-pinned",
      operationKey: "read"
    }, subject)).resolves.toMatchObject({ ok: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fixture.hits).toHaveLength(1);
  });

  it("cancels an oversized streaming response before reading the remaining body", async () => {
    let readCount = 0;
    let cancelled = false;
    let released = false;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount <= 2) {
                return { done: false, value: new Uint8Array(80) };
              }
              return { done: false, value: new Uint8Array(80) };
            },
            async cancel() {
              cancelled = true;
            },
            releaseLock() {
              released = true;
            }
          };
        }
      }
    })));
    const registry = await createRegistry([{
      serviceId: "stream-bounded",
      baseUrl: "http://192.0.2.1:8080",
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/stream",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        payloadTransport: structuredJsonPayloadTransport({ responseMaxBytes: 128 })
      }]
    }]);

    await expect(registry.forward({
      serviceId: "stream-bounded",
      operationKey: "read"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "upstream_response_too_large"
    });
    expect(readCount).toBe(2);
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  it("rejects non-JSON and malformed JSON before configured response filtering can fail open", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("opaque upstream text", {
        status: 200,
        headers: { "content-type": "text/plain" }
      }))
      .mockResolvedValueOnce(new Response("{malformed", {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const registry = await createRegistry([{
      serviceId: "response-filter-closed",
      baseUrl: "http://192.0.2.1:8080",
      operations: [{
        operationKey: "sensitive-only",
        method: "GET",
        path: "/plain",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        sensitiveBodyFields: ["credential"]
      }, {
        operationKey: "public-only",
        method: "GET",
        path: "/malformed",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        publicResponseFields: ["ok"]
      }]
    }]);

    await expect(registry.forward({
      serviceId: "response-filter-closed",
      operationKey: "sensitive-only"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "response_projection_unavailable"
    });
    await expect(registry.forward({
      serviceId: "response-filter-closed",
      operationKey: "public-only"
    }, subject)).rejects.toMatchObject({
      status: 502,
      reasonCode: "response_projection_unavailable"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps caller routing fields rejected while configured operation paths still work", async () => {
    const fixture = await startFixtureServer();
    const registry = await createRegistry([
      {
        serviceId: "default-closed",
        baseUrl: fixture.baseUrl,
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "echo",
            method: "POST",
            path: "/fixed",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          },
          {
            operationKey: "json-rpc",
            protocol: "json-rpc",
            method: "POST",
            path: "/jsonrpc",
            rpcMethod: "fixture.echo",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          }
        ]
      }
    ]);

    const forwarded = await registry.forward({
      serviceId: "default-closed",
      operationKey: "echo",
      body: { message: "configured-path" }
    }, subject);
    expect(forwarded.ok).toBe(true);
    expect(forwarded.response.json.pathname).toBe("/fixed");
    expect(fixture.hits).toHaveLength(1);

    await expect(registry.forward({
      serviceId: "default-closed",
      operationKey: "echo",
      path: "/api/other",
      body: { message: "caller-path" }
    }, subject)).rejects.toMatchObject({ status: 400 });
    await expect(registry.forward({
      serviceId: "default-closed",
      operationKey: "echo",
      rpcMethod: "fixture.override",
      body: { message: "caller-rpc-method" }
    }, subject)).rejects.toMatchObject({ status: 400 });

    const jsonRpcForwarded = await registry.forward({
      serviceId: "default-closed",
      operationKey: "json-rpc",
      body: {
        jsonrpc: "2.0",
        id: "caller-id",
        method: "fixture.override",
        params: { message: "json-rpc-body" }
      }
    }, subject);
    expect(jsonRpcForwarded.ok).toBe(true);
    expect(JSON.parse(fixture.hits.at(-1).body).method).toBe("fixture.echo");
    expect(fixture.hits).toHaveLength(2);
  });

  it("uses the configured relative path and query without caller route fields", async () => {
    const fixture = await startFixtureServer();
    const registry = await createRegistry([
      {
        serviceId: "controlled",
        baseUrl: fixture.baseUrl,
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "read",
            method: "GET",
            path: "/api/echo",
            risk: "read_only",
            requiredScopes: ["gateway:read"]
          }
        ]
      }
    ]);

    const forwarded = await registry.forward({
      serviceId: "controlled",
      operationKey: "read",
      query: { q: "1" }
    }, subject);

    expect(forwarded.ok).toBe(true);
    expect(forwarded.response.json.pathname).toBe("/api/echo");
    expect(forwarded.response.json.search).toBe("?q=1");
    expect(forwarded.response.json.allowedHeader).toBe("");
    expect(fixture.hits).toHaveLength(1);
  });

  it("maps a plugin external-service request through its exact published operation", async () => {
    const fixture = await startFixtureServer();
    const serviceId = "plugin-external-fixture";
    const operationId = "demo.repository.get";
    const registry = await createRegistry([{
      serviceId,
      baseUrl: fixture.baseUrl,
      trafficPolicy: { perMinute: 20, burst: 20 },
      operations: [{
        operationKey: operationId,
        method: "GET",
        path: "/repos/{owner}/{repository}",
        risk: "read_only",
        requiredScopes: ["gateway:read"]
      }]
    }]);

    const result = await registry.requestPluginExternalService({
      pluginId: "demo",
      operationId,
      serviceRef: serviceId,
      operationRef: operationId,
      governance: {
        authorizationContextDigest: "authorization-fixture",
        riskDecisionRef: "risk-fixture",
        policyRevision: "policy-fixture"
      },
      input: {
        owner: "synthetic owner",
        repository: "repository/name",
        ref: "main"
      },
      timeoutMs: 1_000
    }, { subject });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: {
        pathname: "/repos/synthetic%20owner/repository%2Fname",
        search: "?ref=main"
      },
      receiptRef: expect.any(String)
    });
    expect(fixture.hits).toHaveLength(1);

    await expect(registry.requestPluginExternalService({
      pluginId: "demo",
      operationId,
      serviceRef: serviceId,
      operationRef: "demo.repository.other",
      governance: {
        authorizationContextDigest: "authorization-fixture",
        riskDecisionRef: "risk-fixture",
        policyRevision: "policy-fixture"
      },
      input: { owner: "synthetic", repository: "repository" }
    }, { subject })).rejects.toMatchObject({ status: 403 });
    await expect(registry.requestPluginExternalService({
      pluginId: "demo",
      operationId,
      serviceRef: serviceId,
      operationRef: operationId,
      governance: {
        authorizationContextDigest: "authorization-fixture",
        riskDecisionRef: "risk-fixture",
        policyRevision: "policy-fixture"
      },
      input: { owner: "synthetic" }
    }, { subject })).rejects.toMatchObject({ status: 400 });
    expect(fixture.hits).toHaveLength(1);
  });

  it("resolves scoped local secret credentials without exposing secret material", async () => {
    const fixture = await startFixtureServer();
    const serviceId = "credential-bound";
    const { registry, userDataPath } = await createRegistryWithDataDir([
      {
        serviceId,
        baseUrl: fixture.baseUrl,
        credentialRefs: [SECRET_REF],
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "write",
            method: "POST",
            path: "/api/credential",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          }
        ]
      }
    ]);
    await writeLocalSecret({ userDataPath, serviceId, baseUrl: fixture.baseUrl });

    const forwarded = await registry.forward({
      serviceId,
      operationKey: "write",
      body: { message: "credential-check" }
    }, subject);

    expect(forwarded.ok).toBe(true);
    expect(forwarded.response.json.credentialOk).toBe(true);
    expect(JSON.stringify(forwarded)).not.toContain(RESOLVED_SECRET_TOKEN);
    expect(JSON.stringify(registry.listAudit({ serviceId }))).not.toContain(RESOLVED_SECRET_TOKEN);
  });

  it("enforces service-level tag policy before forwarding", async () => {
    const fixture = await startFixtureServer();
    const serviceId = "tag-governed";
    const service = {
      serviceId,
      baseUrl: fixture.baseUrl,
      tagPolicy: {
        entityRefs: [{ entityType: "external_services.service", entityId: serviceId }],
        allowTags: ["upstream-allowed"],
        denyTags: ["upstream-denied"]
      },
      trafficPolicy: { perMinute: 20, burst: 20 },
      operations: [
        {
          operationKey: "read",
          method: "GET",
          path: "/api/tagged",
          risk: "read_only",
          requiredScopes: ["gateway:read"]
        }
      ]
    };
    const allowStore = createStaticTagStore([
      { entityType: "external_services.service", entityId: serviceId, tagId: "upstream-allowed" }
    ]);
    const denyStore = createStaticTagStore([
      { entityType: "external_services.service", entityId: serviceId, tagId: "upstream-denied" }
    ]);
    const { registry: allowedRegistry } = await createRegistryWithDataDir([service], { tagStore: allowStore });
    const allowed = await allowedRegistry.forward({ serviceId, operationKey: "read" }, subject);
    expect(allowed.ok).toBe(true);
    expect(fixture.hits).toHaveLength(1);

    const { registry: deniedRegistry } = await createRegistryWithDataDir([service], { tagStore: denyStore });
    await expect(deniedRegistry.forward({ serviceId, operationKey: "read" }, subject))
      .rejects.toMatchObject({ status: 403 });
    expect(fixture.hits).toHaveLength(1);
    expect(deniedRegistry.previewPolicy({ serviceId, operationKey: "read" }, subject).tagPolicy).toMatchObject({
      enabled: true,
      allowed: false,
      reasonCode: "tag_policy_denied"
    });
  });

  it("rejects scheme-relative, absolute, backslash, and direct host override inputs before fetch", async () => {
    const fixture = await startFixtureServer();
    const registry = await createRegistry([
      {
        serviceId: "controlled",
        baseUrl: fixture.baseUrl,
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "read",
            method: "GET",
            path: "/api",
            risk: "read_only",
            requiredScopes: ["gateway:read"]
          }
        ]
      }
    ]);

    for (const input of [
      { path: "//evil.example/api" },
      { path: "https://evil.example/api" },
      { path: "\\\\evil.example\\api" },
      { host: "evil.example", path: "/api/echo" }
    ]) {
      await expect(registry.forward({
        serviceId: "controlled",
        operationKey: "read",
        ...input
      }, subject)).rejects.toMatchObject({ status: expect.any(Number) });
    }
    expect(fixture.hits).toHaveLength(0);
  });

  it("rejects caller path, method, and header overrides before fetch", async () => {
    const fixture = await startFixtureServer();
    const registry = await createRegistry([
      {
        serviceId: "policy-bound",
        baseUrl: fixture.baseUrl,
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "read",
            method: "GET",
            path: "/api",
            risk: "read_only",
            requiredScopes: ["gateway:read"]
          }
        ]
      }
    ]);

    await expect(registry.forward({
      serviceId: "policy-bound",
      operationKey: "read",
      path: "/admin",
      method: "GET"
    }, subject)).rejects.toMatchObject({ status: 400 });
    await expect(registry.forward({
      serviceId: "policy-bound",
      operationKey: "read",
      path: "/api/echo",
      method: "POST"
    }, subject)).rejects.toMatchObject({ status: 400 });
    await expect(registry.forward({
      serviceId: "policy-bound",
      operationKey: "read",
      path: "/api/echo",
      method: "GET",
      headers: { "X-Not-Allowed": "nope" }
    }, subject)).rejects.toMatchObject({ status: 400 });
    expect(fixture.hits).toHaveLength(0);
  });

  it("does not follow cross-origin redirects from configured operation responses", async () => {
    const fixture = await startFixtureServer();
    const redirectTarget = await startFixtureServer();
    const registry = await createRegistry([
      {
        serviceId: "redirect-guarded",
        baseUrl: fixture.baseUrl,
        trafficPolicy: { perMinute: 20, burst: 20 },
        operations: [
          {
            operationKey: "read",
            method: "GET",
            path: "/api/redirect-cross-origin",
            risk: "read_only",
            requiredScopes: ["gateway:read"]
          }
        ]
      }
    ]);

    const forwarded = await registry.forward({
      serviceId: "redirect-guarded",
      operationKey: "read",
      query: {
        to: `${redirectTarget.baseUrl}/private`
      }
    }, subject);

    expect(forwarded.ok).toBe(false);
    expect(forwarded.upstream.status).toBe(302);
    expect(fixture.hits).toHaveLength(1);
    expect(redirectTarget.hits).toHaveLength(0);
  });
});
