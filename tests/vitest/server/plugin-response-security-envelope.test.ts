import http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpServerLifecycle } from "../../../apps/server/runtime/http-server-lifecycle.ts";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { createCorePlatformProvider } from "../../../packages/server-runtime/src/composition/core-platform-provider.ts";
import { createPluginContributionController } from "../../../packages/server-runtime/src/composition/plugin-contribution-controller.ts";
import { createPluginContributionRegistry } from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.ts";

const PLUGIN_ID: any = "response-boundary-fixture";
const OPERATION_ID: any = "response_boundary_fixture.read";
const ROUTE_PATH: any = "/api/response-boundary-fixture";
const RESPONSE_HEADER_LIMIT: any = 64;
const RESPONSE_HEADER_VALUE_BYTES: any = 1024;
const PRIVATE_MARKER: any = "plugin-private-marker";
const SAFE_BODY: any = "safe-body";
const HTML_BODY: any = `<script>${PRIVATE_MARKER}</script>`;

const logger: Readonly<Record<string, any>> = Object.freeze({
  debug() : any {},
  info() : any {},
  warn() : any {},
  error() : any {}
});

function contributionRecord(kind?: any, id?: any, implementation?: any) : any {
  return Object.freeze({
    pluginId: PLUGIN_ID,
    kind,
    id,
    implementation: Object.freeze(implementation)
  });
}

function operationDefinition() : any {
  const resource: Record<string, any> = {
    capabilityDomain: "plugin-response-boundary",
    resourceKind: "fixture_response",
    capabilityVerb: "read",
    effectKind: "read",
    fieldMap: {}
  };
  return {
    id: OPERATION_ID,
    feature: "system",
    featureId: "core-platform",
    toolsets: ["meshrix.gateway.read"],
    label: "Plugin response boundary fixture",
    target: { controller: "ignored", method: "ignored" },
    http: { method: "POST", path: ROUTE_PATH },
    rpc: { method: OPERATION_ID, body: "params" },
    cli: { command: ["response-boundary-fixture", "read"], usage: "response-boundary-fixture read" },
    public: true,
    readOnly: true,
    concurrencySafe: true,
    requiredScopes: [],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["caseId"],
      properties: {
        caseId: { type: "string", minLength: 1, maxLength: 96 }
      }
    },
    safety: {
      risk: "read_only",
      readOnly: true,
      destructive: false,
      requiresConfirmation: false
    },
    resource,
    resourceContext: { ...resource }
  };
}

function unsafeOverrideHeaders() : any {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Language": "en-US",
    "Content-Disposition": 'attachment; filename="report.txt"',
    "Set-Cookie": `session=${PRIVATE_MARKER}; HttpOnly`,
    "Content-Security-Policy": `default-src *; report-uri /${PRIVATE_MARKER}`,
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": PRIVATE_MARKER,
    "Referrer-Policy": "unsafe-url",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": "camera=*",
    "Strict-Transport-Security": "max-age=0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": PRIVATE_MARKER,
    Host: `${PRIVATE_MARKER}.example.test`,
    Location: `https://${PRIVATE_MARKER}.example.test/`,
    Connection: "X-Plugin-Hop",
    "X-Plugin-Hop": PRIVATE_MARKER,
    "Keep-Alive": "timeout=600",
    Upgrade: "websocket",
    "Proxy-Authenticate": `Basic realm="${PRIVATE_MARKER}"`,
    "Proxy-Authorization": `Basic ${PRIVATE_MARKER}`,
    TE: "trailers",
    Trailer: "X-Plugin-Trailer",
    "Transfer-Encoding": "chunked",
    "Content-Length": "1",
    Via: `1.1 ${PRIVATE_MARKER}`,
    Forwarded: `for=${PRIVATE_MARKER}`,
    "X-Forwarded-For": "192.0.2.60",
    "X-Forwarded-Host": `${PRIVATE_MARKER}.example.test`,
    "X-Forwarded-Proto": "https",
    "X-Real-IP": "192.0.2.61",
    "Cache-Control": "public, max-age=31536000",
    Vary: "Origin"
  };
}

function invalidHeaderCase(caseId?: any) : any {
  if (caseId === "header-crlf-name") {
    return { [`X-Discarded\r\n${PRIVATE_MARKER}`]: "value" };
  }
  if (caseId === "header-crlf-value") {
    return { "X-Discarded": `value\r\nX-Injected: ${PRIVATE_MARKER}` };
  }
  if (caseId === "header-duplicate-case") {
    return {
      "Content-Type": "text/plain",
      "content-type": "application/json"
    };
  }
  if (caseId === "header-count") {
    return Object.fromEntries(
      Array.from({ length: RESPONSE_HEADER_LIMIT + 1 }, (_?: any, index?: any) : any => [
        `X-Discarded-${index}`,
        "value"
      ])
    );
  }
  if (caseId === "header-value-size") {
    return {
      "X-Discarded": `${PRIVATE_MARKER}${"x".repeat(RESPONSE_HEADER_VALUE_BYTES + 1)}`
    };
  }
  if (caseId === "header-non-string-value") {
    return {
      "Set-Cookie": [`a=${PRIVATE_MARKER}`, `b=${PRIVATE_MARKER}`]
    };
  }
  throw new Error(`Unknown invalid header case ${caseId}.`);
}

function pluginResponse(caseId?: any) : any {
  if (caseId === "unsafe-overrides") {
    return {
      statusCode: 207,
      headers: unsafeOverrideHeaders(),
      body: SAFE_BODY
    };
  }
  if (caseId === "html-default") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": "inline",
        "Content-Language": "en-US"
      },
      body: HTML_BODY
    };
  }
  if (caseId === "status-599") {
    return {
      statusCode: 599,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: SAFE_BODY
    };
  }
  if (caseId.startsWith("status-")) {
    return {
      statusCode: Number(caseId.slice("status-".length)),
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Discarded": PRIVATE_MARKER
      },
      body: PRIVATE_MARKER
    };
  }
  if (caseId.startsWith("header-")) {
    return {
      statusCode: 200,
      headers: invalidHeaderCase(caseId),
      body: PRIVATE_MARKER
    };
  }
  throw new Error(`Unknown plugin response case ${caseId}.`);
}

function createEnabledPluginRuntime() : any {
  const manifest: Readonly<Record<string, any>> = Object.freeze({
    id: PLUGIN_ID,
    version: "0.0.1",
    features: Object.freeze(["core-platform"]),
    operations: Object.freeze([OPERATION_ID]),
    routes: Object.freeze([{
      id: `${OPERATION_ID}.http`,
      path: ROUTE_PATH,
      kind: "http"
    }]),
    mcpTools: Object.freeze([]),
    consoleEntries: Object.freeze([]),
    stateMachines: Object.freeze([]),
    verifierHooks: Object.freeze([])
  });
  const contributions: Record<string, any> = {
    operations: {
      [OPERATION_ID]: contributionRecord("operations", OPERATION_ID, {
        definition: operationDefinition(),
        requiredHostPorts: [],
        async execute({ input }: Record<string, any>) : Promise<any> {
          return pluginResponse(input.caseId);
        }
      })
    },
    routes: {
      [`${OPERATION_ID}.http`]: contributionRecord("routes", `${OPERATION_ID}.http`, {
        operationId: OPERATION_ID
      })
    },
    mcpTools: {},
    consoleEntries: {},
    stateMachines: {},
    verifierHooks: {}
  };
  const registry: any = createPluginContributionRegistry({
    manifests: [manifest],
    loadedPlugins: [manifest],
    contributions,
    coreOperations: [],
    activeFeatureIds: ["core-platform"],
    artifactIdentityResolver: () : any => Object.freeze({
      pluginId: PLUGIN_ID,
      version: "0.0.1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      generation: 1,
      keyId: "ed25519:fixture",
      coreContractDigest: `sha256:${"b".repeat(64)}`
    }),
    artifactFileReader: async () : Promise<any> => Buffer.alloc(0)
  });
  return {
    registry,
    controller: createPluginContributionController({ registry })
  };
}

function allowedRateLimiter() : any {
  return Object.freeze({
    shouldAllow() : any {
      return {
        allowed: true,
        limit: 10_000,
        remaining: 9_999,
        resetAt: Date.now() + 60_000
      };
    }
  });
}

function rawHeaderValues(result?: any, name?: any) : any {
  const target: any = String(name).toLowerCase();
  const values: any[] = [];
  for (let index: any = 0; index < result.rawHeaders.length; index += 2) {
    if (String(result.rawHeaders[index]).toLowerCase() === target) {
      values.push(String(result.rawHeaders[index + 1]));
    }
  }
  return values;
}

function onlyHeader(result?: any, name?: any) : any {
  const values: any = rawHeaderValues(result, name);
  expect(values, `expected exactly one ${name} response header`).toHaveLength(1);
  return values[0];
}

function expectCoreSecurityEnvelope(result?: any, expectedBody?: any) : any {
  expect(result.upgraded).toBe(false);
  expect(result.information).toEqual([]);
  expect(onlyHeader(result, "x-content-type-options")).toBe("nosniff");
  expect(onlyHeader(result, "x-frame-options")).toBe("DENY");
  expect(onlyHeader(result, "referrer-policy")).toBe("same-origin");
  expect(onlyHeader(result, "cross-origin-resource-policy")).toBe("same-origin");
  expect(onlyHeader(result, "permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  const csp: any = onlyHeader(result, "content-security-policy");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain(PRIVATE_MARKER);
  expect(onlyHeader(result, "cache-control")).toBe("private, no-store");
  expect(onlyHeader(result, "content-length")).toBe(String(Buffer.byteLength(expectedBody)));
  expect(rawHeaderValues(result, "transfer-encoding")).toEqual([]);
  expect(rawHeaderValues(result, "strict-transport-security")).toEqual([]);
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers"
  ]) {
    expect(rawHeaderValues(result, name)).toEqual([]);
  }
}

function expectInvalidPluginResponse(result?: any) : any {
  const expectedBody: any = JSON.stringify({
    ok: false,
    error: {
      code: "plugin_response_invalid",
      retryable: false
    }
  });
  expect(result.statusCode).toBe(502);
  expect(result.body).toBe(expectedBody);
  expect(result.body).not.toContain(PRIVATE_MARKER);
  expect(onlyHeader(result, "content-type")).toBe("application/json; charset=utf-8");
  expectCoreSecurityEnvelope(result, expectedBody);
}

let server: any;
let lifecycle: any;
let listenUrl: any;

beforeAll(async () : Promise<any> => {
  const { registry, controller } = createEnabledPluginRuntime();
  const registeredCoreProvider: any = createCorePlatformProvider({
    operations: registry.activeOperations,
    getOperations: () : any => registry.currentActiveOperations(),
    operationConcurrencyScope: "plugin-response-security-envelope"
  });

  server = http.createServer();
  lifecycle = createHttpServerLifecycle({
    server,
    runtimeLogger: logger,
    transportLimits: {
      requestTimeoutMs: 5_000,
      headersTimeoutMs: 5_000,
      keepAliveTimeoutMs: 500,
      maxRequestsPerSocket: 1,
      maxHeadersCount: 100
    }
  });
  const requestHandler: any = createHttpServerRequestHandler({
    activeApiOperations: registry.activeOperations,
    getActiveApiOperations: () : any => registry.currentActiveOperations(),
    consoleAuth: { getSessionFromRequest: () : any => null },
    controllers: { plugin: controller },
    distPath: "",
    getDiscoveryState: () : any => ({ mode: "local" }),
    getListenUrl: () : any => listenUrl,
    getOperationPermissionPlatform: () : any => null,
    lifecycle,
    loginRateLimiter: allowedRateLimiter(),
    operationAuditStore: null,
    operationConcurrencyScope: "plugin-response-security-envelope",
    pluginContributions: registry,
    proxyApiRequest: async () : Promise<any> => {
      throw new Error("The plugin fixture must not enter the proxy path.");
    },
    rateLimits: { windowMs: 60_000 },
    registeredCoreProvider,
    runtimeLogger: logger,
    securityPermissions: {
      async authorizeOperation() : Promise<any> {
        return {
          ok: true,
          session: null,
          authorizationDecision: {
            allowed: true,
            decisionId: "fixture-public-decision",
            reasonCode: "allowed_public"
          }
        };
      },
      async verifyProcessIdentity() : Promise<any> {
        return { ok: true };
      }
    },
    subjectRateLimiter: allowedRateLimiter(),
    tenantRateLimiter: allowedRateLimiter(),
    toolSkillManagementProvider: {},
    upstreamGatewayRegistryForMcp: null,
    ipRateLimiter: allowedRateLimiter()
  });
  server.on("request", requestHandler);
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.removeAllListeners("error");
  lifecycle.openAdmission();
  const address: any = server.address();
  listenUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () : Promise<any> => {
  lifecycle?.sealAdmission(new Error("Plugin response acceptance server is closing."));
  lifecycle?.abortInflight(new Error("Plugin response acceptance server is closing."));
  for (const socket of lifecycle?.openSockets || []) socket.destroy();
  if (server?.listening) {
    await new Promise((resolve?: any) : any => server.close(resolve));
  }
});

function invokePlugin(caseId?: any) : any {
  const requestBody: any = Buffer.from(JSON.stringify({ caseId }));
  return new Promise((resolve?: any, reject?: any) : any => {
    const information: any[] = [];
    let settled: any = false;
    let timeout: any = null;
    const settle: any = (callback?: any, value?: any) : any => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const request: any = http.request(`${listenUrl}${ROUTE_PATH}`, {
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": String(requestBody.length),
        connection: "close",
        origin: "https://untrusted.example.test"
      }
    });
    timeout = setTimeout(() : any => {
      request.destroy();
      settle(reject, new Error(`Plugin response case ${caseId} timed out.`));
    }, 1_500);
    request.on("information", (entry?: any) : any => {
      information.push(entry.statusCode);
    });
    request.on("upgrade", (response?: any, socket?: any, head?: any) : any => {
      socket.destroy();
      settle(resolve, {
        statusCode: response.statusCode,
        rawHeaders: response.rawHeaders,
        body: head.toString("utf8"),
        information,
        upgraded: true
      });
    });
    request.on("response", (response?: any) : any => {
      const chunks: any[] = [];
      response.on("data", (chunk?: any) : any => chunks.push(Buffer.from(chunk)));
      response.on("end", () : any => {
        settle(resolve, {
          statusCode: response.statusCode,
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
          information,
          upgraded: false
        });
      });
      response.on("error", (error?: any) : any => settle(reject, error));
    });
    request.on("error", (error?: any) : any => settle(reject, error));
    request.end(requestBody);
  });
}

describe("installed plugin HTTP response security envelope", () : any => {
  it("keeps approved representation metadata while Core replaces every protected header and framing value", async () : Promise<any> => {
    const result: any = await invokePlugin("unsafe-overrides");

    expect(result.statusCode).toBe(207);
    expect(result.body).toBe(SAFE_BODY);
    expect(onlyHeader(result, "content-type")).toBe("text/plain; charset=utf-8");
    expect(onlyHeader(result, "content-language")).toBe("en-US");
    expect(onlyHeader(result, "content-disposition")).toBe('attachment; filename="report.txt"');
    expectCoreSecurityEnvelope(result, SAFE_BODY);

    for (const name of [
      "set-cookie",
      "host",
      "location",
      "keep-alive",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "via",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "x-plugin-hop",
      "vary"
    ]) {
      expect(rawHeaderValues(result, name), `${name} must not cross the plugin response boundary`).toEqual([]);
    }
    expect(rawHeaderValues(result, "connection").join(",").toLowerCase()).not.toContain("x-plugin-hop");
    expect(result.rawHeaders.join("\n")).not.toContain(PRIVATE_MARKER);
  });

  it("forces plugin HTML to a safe attachment because no isolated HTML capability exists", async () : Promise<any> => {
    const result: any = await invokePlugin("html-default");

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(HTML_BODY);
    expect(onlyHeader(result, "content-type")).toBe("application/octet-stream");
    expect(onlyHeader(result, "content-language")).toBe("en-US");
    expect(onlyHeader(result, "content-disposition").toLowerCase()).toMatch(/^attachment(?:;|$)/u);
    expectCoreSecurityEnvelope(result, HTML_BODY);
  });

  it("accepts only final non-redirect statuses and rejects 1xx, switching, redirects, and values above 599", async () : Promise<any> => {
    const upperBound: any = await invokePlugin("status-599");
    expect(upperBound.statusCode).toBe(599);
    expect(upperBound.body).toBe(SAFE_BODY);
    expectCoreSecurityEnvelope(upperBound, SAFE_BODY);

    for (const statusCode of [100, 101, 199, 302, 399, 600, 999]) {
      expectInvalidPluginResponse(await invokePlugin(`status-${statusCode}`));
    }
  }, 15_000);

  it("rejects malformed, duplicate, unbounded, or non-string plugin header collections before filtering", async () : Promise<any> => {
    for (const caseId of [
      "header-crlf-name",
      "header-crlf-value",
      "header-duplicate-case",
      "header-count",
      "header-value-size",
      "header-non-string-value"
    ]) {
      expectInvalidPluginResponse(await invokePlugin(caseId));
    }
  }, 15_000);
});
