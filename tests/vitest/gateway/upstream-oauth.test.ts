import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createUpstreamOAuthClient } from "../../../packages/agents/src/upstream-gateway/oauth-client.ts";
import { initializeLocalSecret } from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createMemoryLocalSecretKeyProvider } from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import { validateUpstreamOauth } from "../../../packages/contracts/src/upstream-service-publishing.ts";

const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: {
    id: "grant",
    subjectId: "operator",
    dynamicCapabilities: ["cap:upstream:guarded:run"]
  },
  scopes: ["gateway:read", "gateway:write"],
  dynamicCapabilities: ["cap:upstream:guarded:run"]
};

const OAUTH = {
  grantType: "client_credentials",
  tokenUrl: "",
  clientId: "meshrix-gateway",
  clientSecretRef: "secret://meshrix/oauth-client",
  scopes: ["tools:invoke"],
  audience: "guarded-api",
  authMethod: "client_secret_basic"
};

function oauthService(overrides: Record<string, any> = {}) : any {
  return structuredUpstreamServiceFixture({
    serviceId: "guarded",
    serviceProtocol: "http",
    label: "guarded",
    allowLocalNetwork: true,
    operations: [{
      operationKey: "run",
      method: "POST",
      path: "/run",
      risk: "read_only",
      requiredScopes: ["gateway:write"]
    }],
    ...overrides
  });
}

async function tokenPeer(handler?: (params: URLSearchParams, request: any) => any) : Promise<any> {
  const state = { hits: 0, bodies: [] as URLSearchParams[], authorizations: [] as string[] };
  const peer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    state.hits += 1;
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    state.bodies.push(params);
    state.authorizations.push(String(request.headers.authorization || ""));
    const result = handler
      ? handler(params, request)
      : { access_token: `synthetic-token-${state.hits}`, token_type: "Bearer", expires_in: 3600 };
    response.writeHead(result.status || 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body || result));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic token endpoint is unavailable.");
  return { url: `http://127.0.0.1:${address.port}`, state, close: () => new Promise<void>((resolve) => peer.close(() => resolve())) };
}

async function resourcePeer() : Promise<any> {
  const state = { hits: 0, authorizations: [] as string[] };
  const peer = createServer((request, response) => {
    state.hits += 1;
    state.authorizations.push(String(request.headers.authorization || ""));
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic upstream peer is unavailable.");
  return { url: `http://127.0.0.1:${address.port}`, state, close: () => new Promise<void>((resolve) => peer.close(() => resolve())) };
}

const KEY_PROVIDER = createMemoryLocalSecretKeyProvider({ key: Buffer.alloc(32, 0x42) });

async function seedClientSecret(dataDir: string, scope: Record<string, any> = {}) : Promise<any> {
  await initializeLocalSecret({
    dataDir,
    keyProvider: KEY_PROVIDER,
    target: {
      provider: "fixture-provider",
      family: "upstream-gateway",
      authType: "oauth-client-secret",
      secretRef: OAUTH.clientSecretRef,
      scope: {
        serviceId: "guarded",
        scopes: ["gateway:read", "gateway:write"],
        ...scope
      }
    },
    payload: { clientSecret: "synthetic-client-secret" }
  });
}

function tokenOriginScope(tokenUrl: string) : any {
  const origin = new URL(tokenUrl).origin;
  return {
    allowedHosts: [new URL(tokenUrl).hostname],
    allowedProtocols: ["http"],
    allowedOrigins: [origin]
  };
}

function registryFor(dataDir: string) : any {
  let claims = 0;
  return createUpstreamGatewayRegistry({
    userDataPath: dataDir,
    schemaPort: createGatewaySchemaPort(),
    secretKeyProvider: KEY_PROVIDER,
    claimProtectedSinkAttempt: async () => {
      claims += 1;
      return Object.freeze({ id: `claim-${claims}`, consumed: true });
    }
  });
}

describe("Upstream OAuth client-credentials lifecycle", () => {
  it("injects a fetched bearer token and reuses it while fresh", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "meshrix-oauth-"));
    const token = await tokenPeer();
    const upstream = await resourcePeer();
    await seedClientSecret(dataDir, tokenOriginScope(token.url));
    const registry = registryFor(dataDir);
    installUpstreamRuntimeServices(registry, [oauthService({
      baseUrl: upstream.url,
      oauth: { ...OAUTH, tokenUrl: `${token.url}/oauth/token` }
    })]);
    try {
      await registry.forward({ serviceId: "guarded", operationKey: "run", body: { call: 1 } }, SUBJECT);
      await registry.forward({ serviceId: "guarded", operationKey: "run", body: { call: 2 } }, SUBJECT);
      expect(upstream.state.hits).toBe(2);
      const expectedBearer: any = ["Bearer", "synthetic-token-1"].join(" ");
      expect(upstream.state.authorizations).toEqual([expectedBearer, expectedBearer]);
      expect(token.state.hits).toBe(1);
      expect(token.state.bodies[0].get("grant_type")).toBe("client_credentials");
      expect(token.state.bodies[0].get("scope")).toBe("tools:invoke");
      expect(token.state.bodies[0].get("audience")).toBe("guarded-api");
      const expectedBasic = `Basic ${Buffer.from("meshrix-gateway:synthetic-client-secret", "utf8").toString("base64")}`;
      expect(token.state.authorizations[0]).toBe(expectedBasic);
    } finally {
      await registry.close();
      await token.close();
      await upstream.close();
    }
  });

  it("fails closed without touching upstream when the token endpoint rejects", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "meshrix-oauth-"));
    const token = await tokenPeer(() => ({ status: 401, body: { error: "invalid_client" } }));
    const upstream = await resourcePeer();
    await seedClientSecret(dataDir, tokenOriginScope(token.url));
    const registry = registryFor(dataDir);
    installUpstreamRuntimeServices(registry, [oauthService({
      baseUrl: upstream.url,
      oauth: { ...OAUTH, tokenUrl: `${token.url}/oauth/token` }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: "run", body: { call: 1 } },
        SUBJECT
      )).rejects.toMatchObject({ status: 502, reasonCode: "upstream_oauth_token_failed" });
      expect(upstream.state.hits).toBe(0);
    } finally {
      await registry.close();
      await token.close();
      await upstream.close();
    }
  });

  it("denies a client secret bound to a different origin", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "meshrix-oauth-"));
    const token = await tokenPeer();
    const upstream = await resourcePeer();
    await seedClientSecret(dataDir, {
      allowedHosts: ["idp.example.test"],
      allowedProtocols: ["https"],
      allowedOrigins: ["https://idp.example.test"]
    });
    const registry = registryFor(dataDir);
    installUpstreamRuntimeServices(registry, [oauthService({
      baseUrl: upstream.url,
      oauth: { ...OAUTH, tokenUrl: `${token.url}/oauth/token` }
    })]);
    try {
      await expect(registry.forward(
        { serviceId: "guarded", operationKey: "run", body: { call: 1 } },
        SUBJECT
      )).rejects.toMatchObject({ statusCode: 403, code: "local_secret_scope_denied" });
      expect(upstream.state.hits).toBe(0);
      expect(token.state.hits).toBe(0);
    } finally {
      await registry.close();
      await token.close();
      await upstream.close();
    }
  });
});

describe("Upstream OAuth token client", () => {
  function clientFixture() : any {
    const requests: URLSearchParams[] = [];
    const clock = { value: 1_000_000 };
    const client = createUpstreamOAuthClient({
      now: () => clock.value,
      fetchToken: async (_service: any, _url: string, init: any) => {
        requests.push(new URLSearchParams(String(init.body)));
        const count = requests.length;
        return {
          response: {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              access_token: `tok-${count}`,
              token_type: "Bearer",
              expires_in: 3600
            })
          },
          close: async () => {}
        };
      }
    });
    const oauth = { ...OAUTH, tokenUrl: "https://idp.example.test/oauth/token" };
    const service = { serviceId: "guarded", serviceRevision: 1 };
    return { client, requests, clock, oauth, service };
  }

  it("coalesces concurrent misses into one token request and refreshes after expiry", async () => {
    const { client, requests, clock, oauth, service } = clientFixture();
    const request = { service, oauth, clientSecret: "synthetic-client-secret", secretRevision: 1 };
    const [first, second] = await Promise.all([
      client.accessTokenFor(request),
      client.accessTokenFor(request)
    ]);
    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect(requests).toHaveLength(1);
    clock.value += 3_600_000;
    expect(await client.accessTokenFor(request)).toBe("tok-2");
    expect(requests).toHaveLength(2);
  });

  it("refetches when the client secret rotates to a new revision", async () => {
    const { client, requests, oauth, service } = clientFixture();
    const base = { service, oauth, clientSecret: "synthetic-client-secret" };
    expect(await client.accessTokenFor({ ...base, secretRevision: 1 })).toBe("tok-1");
    expect(await client.accessTokenFor({ ...base, secretRevision: 2 })).toBe("tok-2");
    expect(requests).toHaveLength(2);
  });

  it("sends client_secret_post credentials in the form body", async () => {
    const { client, requests, oauth, service } = clientFixture();
    await client.accessTokenFor({
      service,
      oauth: { ...oauth, authMethod: "client_secret_post" },
      clientSecret: "synthetic-client-secret",
      secretRevision: 1
    });
    expect(requests[0].get("client_id")).toBe("meshrix-gateway");
    expect(requests[0].get("client_secret")).toBe("synthetic-client-secret");
  });
});

describe("Upstream OAuth descriptor validation", () => {
  it("accepts a complete client_credentials declaration", () => {
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: "https://idp.example.test/token" })).not.toThrow();
  });

  it("rejects malformed declarations", () => {
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: "https://idp.example.test/token", grantType: "password" }))
      .toThrow(/grantType/u);
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: ["https://", "user:pw@idp.example.test/token"].join("") }))
      .toThrow(/tokenUrl/u);
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: "https://idp.example.test/token", clientSecretRef: "https://vault/x" }))
      .toThrow(/clientSecretRef/u);
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: "https://idp.example.test/token", authMethod: "private_key_jwt" }))
      .toThrow(/authMethod/u);
    expect(() => validateUpstreamOauth({ ...OAUTH, tokenUrl: "https://idp.example.test/token", extra: true }))
      .toThrow(/Unknown/u);
  });
});
