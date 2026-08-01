import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConfigRegistry } from "#meshrix/agents/agent-configs/config-registry";
import { callAgentGateway } from "#meshrix/agents/agent-gateway/index";
import {
  resolveCredentialMaterial
} from "#meshrix/agents/upstream-gateway/credential-material";
import {
  createUpstreamGatewayRegistry
} from "#meshrix/agents/upstream-gateway/index";
import {
  compileOutboundCredentialHeaders
} from "#meshrix/foundation/security/outbound-credential-header-policy";
import {
  encryptLocalSecretPayload
} from "#meshrix/foundation/security/secrets/local-secret-envelope";
import {
  createMemoryLocalSecretKeyProvider
} from "#meshrix/foundation/security/secrets/local-secret-key-provider";
import {
  LOCAL_SECRET_STORE_VERSION,
  initializeLocalSecret,
  listLocalSecretEntries,
  resolveLocalSecretPayload,
  rotateLocalSecret
} from "#meshrix/foundation/security/secrets/local-secret-store";
import {
  localSecretStorePaths,
  readLocalSecretJson,
  writeLocalSecretJson
} from "#meshrix/foundation/security/secrets/local-secret-storage";
import {
  normalizeAgentModelPayload
} from "#meshrix/server-runtime/composition/console-domain/operation-executors/settings-agent-gateway-models";
import {
  installUpstreamRuntimeServices,
  structuredJsonPayloadTransport
} from "../../helpers/upstream-runtime-snapshot.ts";
import {
  normalizeService
} from "../../../packages/agents/src/upstream-gateway/support.ts";

const SECRET_REF: any = "secret://credential-header-policy/fixture";
const SERVICE_ID: any = "credential-header-policy-fixture";
const CREDENTIAL_MARKER: any = "synthetic-private-credential-marker";
const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "credential-header-policy-subject",
  scopes: Object.freeze(["gateway:read", "gateway:write"])
});

const ALLOWED_HEADER_ENTRIES: readonly any[] = Object.freeze([
  Object.freeze(["Authorization", `Bearer ${CREDENTIAL_MARKER}`]),
  Object.freeze(["Api-Key", `${CREDENTIAL_MARKER}-api-key`]),
  Object.freeze(["X-Api-Key", `${CREDENTIAL_MARKER}-x-api-key`]),
  Object.freeze(["X-Auth-Token", `${CREDENTIAL_MARKER}-x-auth-token`]),
  Object.freeze(["X-Partner-Token", `${CREDENTIAL_MARKER}-partner`])
]);

const HOSTILE_HEADER_VECTORS: readonly any[] = Object.freeze([
  Object.freeze({
    id: "host",
    entries: Object.freeze([Object.freeze(["Host", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "connection",
    entries: Object.freeze([Object.freeze(["Connection", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "te",
    entries: Object.freeze([Object.freeze(["TE", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "trailer",
    entries: Object.freeze([Object.freeze(["Trailer", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "transfer-encoding",
    entries: Object.freeze([Object.freeze(["Transfer-Encoding", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "content-length",
    entries: Object.freeze([Object.freeze(["Content-Length", "7"])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "upgrade",
    entries: Object.freeze([Object.freeze(["Upgrade", CREDENTIAL_MARKER])]),
    reasonCode: "header_transport_reserved"
  }),
  Object.freeze({
    id: "cookie",
    entries: Object.freeze([Object.freeze(["Cookie", CREDENTIAL_MARKER])]),
    reasonCode: "header_cookie_reserved"
  }),
  Object.freeze({
    id: "set-cookie",
    entries: Object.freeze([Object.freeze(["Set-Cookie", CREDENTIAL_MARKER])]),
    reasonCode: "header_cookie_reserved"
  }),
  Object.freeze({
    id: "proxy-prefix",
    entries: Object.freeze([Object.freeze(["Proxy-Authorization", CREDENTIAL_MARKER])]),
    reasonCode: "header_proxy_reserved"
  }),
  Object.freeze({
    id: "forwarded",
    entries: Object.freeze([Object.freeze(["Forwarded", `for=${CREDENTIAL_MARKER}`])]),
    reasonCode: "header_forwarding_reserved"
  }),
  Object.freeze({
    id: "x-forwarded-prefix",
    entries: Object.freeze([Object.freeze(["X-Forwarded-For", CREDENTIAL_MARKER])]),
    reasonCode: "header_forwarding_reserved"
  }),
  Object.freeze({
    id: "meshrix-internal",
    entries: Object.freeze([Object.freeze(["X-Meshrix-Capability-Key", CREDENTIAL_MARKER])]),
    reasonCode: "header_internal_reserved"
  }),
  Object.freeze({
    id: "unapproved-standard-header",
    entries: Object.freeze([Object.freeze(["Authentication", CREDENTIAL_MARKER])]),
    reasonCode: "header_not_allowed"
  }),
  Object.freeze({
    id: "name-crlf",
    entries: Object.freeze([Object.freeze(["X-Partner\r\nInjected", CREDENTIAL_MARKER])]),
    reasonCode: "header_name_invalid"
  }),
  Object.freeze({
    id: "value-crlf",
    entries: Object.freeze([Object.freeze([
      "Authorization",
      `Bearer ${CREDENTIAL_MARKER}\r\nX-Injected: yes`
    ])]),
    reasonCode: "header_value_invalid"
  }),
  Object.freeze({
    id: "value-nul",
    entries: Object.freeze([Object.freeze([
      "Authorization",
      `Bearer ${CREDENTIAL_MARKER}\u0000suffix`
    ])]),
    reasonCode: "header_value_invalid"
  }),
  Object.freeze({
    id: "case-folded-duplicate",
    entries: Object.freeze([
      Object.freeze(["Authorization", `Bearer ${CREDENTIAL_MARKER}`]),
      Object.freeze(["authorization", `Bearer ${CREDENTIAL_MARKER}-other`])
    ]),
    reasonCode: "header_name_duplicate"
  })
]);

const cleanupTasks: any[] = [];

beforeEach(() : any => {
  vi.stubEnv(
    "MESHRIX_MODEL_CREDENTIAL_MASTER_KEY",
    "synthetic-model-credential-master-key-material"
  );
});

afterEach(async () : Promise<any> => {
  vi.unstubAllEnvs();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()();
  }
});

async function temporaryRoot(label?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  cleanupTasks.push(() : any => fs.rm(root, { force: true, recursive: true }));
  return root;
}

function opaquePayloadTransport(maxBytes: any = 1024 * 1024) : any {
  return {
    request: {
      mode: "opaque_stream",
      maxBytes,
      mediaTypes: ["application/octet-stream"]
    },
    response: {
      mode: "opaque_stream",
      maxBytes,
      mediaTypes: ["application/octet-stream"]
    }
  };
}

function serviceDescriptor(baseUrl?: any) : any {
  const endpoint: any = new URL(baseUrl);
  return {
    serviceId: SERVICE_ID,
    serviceProtocol: "http",
    baseUrl,
    allowLocalNetwork: true,
    credentialReferences: [{
      type: "credential",
      reference: SECRET_REF,
      host: endpoint.hostname,
      protocol: endpoint.protocol.replace(/:$/u, ""),
      scopes: ["gateway:write"]
    }],
    operations: [{
      operationKey: "structured",
      method: "POST",
      path: "/structured",
      protocol: "http",
      risk: "safe_write",
      requiredScopes: ["gateway:write"],
      payloadTransport: structuredJsonPayloadTransport()
    }, {
      operationKey: "stream",
      method: "POST",
      path: "/stream",
      protocol: "http",
      risk: "safe_write",
      requiredScopes: ["gateway:write"],
      payloadTransport: opaquePayloadTransport()
    }]
  };
}

function secretTarget(baseUrl?: any) : any {
  const endpoint: any = new URL(baseUrl);
  return {
    provider: "credential-header-policy-test",
    family: "upstream-gateway",
    authType: "header",
    secretRef: SECRET_REF,
    scope: {
      serviceId: SERVICE_ID,
      scopes: ["gateway:write"],
      allowedHosts: [endpoint.hostname],
      allowedProtocols: [endpoint.protocol.replace(/:$/u, "")]
    }
  };
}

function safeAgent(baseUrl?: any, overrides: Record<string, any> = {}) : any {
  return {
    uid: "agent_credential_header_policy",
    instanceId: "agent_credential_header_policy",
    alias: "agent_credential_header_policy",
    provider: "openai",
    label: "Credential header policy fixture",
    baseUrl: `${baseUrl}/v1`,
    model: "synthetic-model",
    apiKey: CREDENTIAL_MARKER,
    apiKeyConfigured: true,
    tokenHeader: "Authorization",
    tokenPrefix: "Bearer ",
    timeoutMs: 5000,
    moduleAccess: {
      mode: "selected",
      moduleIds: []
    },
    ...overrides
  };
}

function payloadFor(entries?: any) : any {
  return {
    headers: Object.fromEntries(entries)
  };
}

function headerValues(rawHeaders?: any, expectedName?: any) : any {
  const folded: any = String(expectedName).toLowerCase();
  const values: any[] = [];
  for (let index: any = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === folded) {
      values.push(String(rawHeaders[index + 1]));
    }
  }
  return values;
}

async function startLoopbackPeer() : Promise<any> {
  const requests: any[] = [];
  let connectionCount: any = 0;
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const chunks: any[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const pathname: any = new URL(request.url || "/", "http://127.0.0.1").pathname;
    requests.push({
      body: Buffer.concat(chunks),
      method: request.method,
      pathname,
      rawHeaders: [...request.rawHeaders]
    });
    if (pathname === "/stream") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/octet-stream"
      });
      response.end(Buffer.from("stream-ok"));
      return;
    }
    if (pathname === "/v1/chat/completions") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        id: "credential-header-policy-response",
        model: "synthetic-model",
        choices: [{
          finish_reason: "stop",
          message: {
            content: "policy-ok"
          }
        }]
      }));
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json"
    });
    response.end(JSON.stringify({ ok: true }));
  });
  server.on("connection", () : any => {
    connectionCount += 1;
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanupTasks.push(async () : Promise<any> => {
    server.closeAllConnections?.();
    await new Promise((resolve?: any) : any => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    connectionCount: () : any => connectionCount,
    requests
  };
}

async function createGatewayFixture() : Promise<any> {
  const peer: any = await startLoopbackPeer();
  const userDataPath: any = await temporaryRoot("meshrix-credential-header-policy");
  const secretKeyProvider: any = createMemoryLocalSecretKeyProvider();
  cleanupTasks.push(() : any => secretKeyProvider.close());
  const registry: any = createUpstreamGatewayRegistry({
    secretKeyProvider,
    userDataPath
  });
  cleanupTasks.push(() : any => registry.close());
  const descriptor: any = serviceDescriptor(peer.baseUrl);
  installUpstreamRuntimeServices(registry, [descriptor]);
  await initializeLocalSecret({
    dataDir: userDataPath,
    keyProvider: secretKeyProvider,
    payload: payloadFor(ALLOWED_HEADER_ENTRIES),
    target: secretTarget(peer.baseUrl)
  });
  return {
    descriptor: normalizeService(descriptor, {}),
    peer,
    registry,
    secretKeyProvider,
    userDataPath
  };
}

function secretEnvelopeBinding(entry?: any) : any {
  return {
    protocolVersion: LOCAL_SECRET_STORE_VERSION,
    secretRef: entry.secretRef,
    provider: entry.provider,
    family: entry.family,
    authType: entry.authType,
    revision: entry.revision,
    metadata: entry.metadata,
    valueKeys: [...entry.valueKeys].sort()
  };
}

async function replaceWithLegacyEncryptedPayload({
  userDataPath,
  secretKeyProvider,
  payload
}: Record<string, any>) : Promise<any> {
  const paths: any = localSecretStorePaths({ dataDir: userDataPath });
  const registry: any = await readLocalSecretJson(paths.registryPath, null);
  const entry: any = registry.refs[SECRET_REF];
  const fileName: any = entry.storageRef.slice("local:".length);
  const valuePath: any = path.join(paths.valuesDir, fileName);
  const valueRecord: any = await readLocalSecretJson(valuePath, null);
  const envelope: any = await encryptLocalSecretPayload({
    binding: secretEnvelopeBinding(entry),
    keyProvider: secretKeyProvider,
    payload
  });
  await writeLocalSecretJson(valuePath, {
    ...valueRecord,
    envelope
  });
}

async function captureRejection(promise?: any) : Promise<any> {
  try {
    await promise;
  } catch (error: any) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function expectPolicyDenial(error?: any, reasonCode?: any) : any {
  expect(error).toMatchObject({
    code: "outbound_credential_header_policy_denied",
    reasonCode
  });
  expect(String(error.message || "")).not.toContain(CREDENTIAL_MARKER);
}

function expectCredentialUseDenial(error?: any, reasonCode?: any) : any {
  expect(error).toMatchObject({
    policyReasonCode: reasonCode,
    reasonCode: "outbound_credential_header_policy_denied",
    status: 403
  });
  expect(String(error.message || "")).not.toContain(CREDENTIAL_MARKER);
}

async function forwardStructured(registry?: any) : Promise<any> {
  return registry.forward({
    serviceId: SERVICE_ID,
    operationKey: "structured",
    body: {
      fixture: true
    }
  }, SUBJECT);
}

async function forwardStream(registry?: any) : Promise<any> {
  const responseChunks: any[] = [];
  const requestBytes: any = Buffer.from("stream-request");
  const result: any = await registry.forwardHttpStream({
    serviceId: SERVICE_ID,
    operationKey: "stream",
    contentLength: requestBytes.byteLength,
    requestHeaders: {
      "content-type": "application/octet-stream"
    },
    requestStream: Readable.from([requestBytes])
  }, SUBJECT, {
    async consumeResponse(upstream?: any) : Promise<any> {
      for await (const chunk of upstream.body) {
        responseChunks.push(Buffer.from(chunk));
      }
    }
  });
  return {
    responseBody: Buffer.concat(responseChunks),
    result
  };
}

async function callModel(agent?: any, userDataPath?: any) : Promise<any> {
  return callAgentGateway({
    settings: {
      modelLibraryAgents: [agent]
    },
    input: {
      provider: agent.provider,
      modelAlias: agent.uid,
      question: "Return a synthetic response."
    },
    fetchImpl: fetch,
    userDataPath,
    contextCompactionSource: "agent_gateway.call",
    egressLookup: async () : Promise<any> => [{
      address: "127.0.0.1",
      family: 4
    }]
  });
}

describe("canonical outbound credential header policy", () : any => {
  it("admits only default Authorization, approved auth headers, and controlled x-* headers", () : any => {
    const compiled: any = compileOutboundCredentialHeaders(ALLOWED_HEADER_ENTRIES);
    expect(compiled).toEqual({
      authorization: `Bearer ${CREDENTIAL_MARKER}`,
      "api-key": `${CREDENTIAL_MARKER}-api-key`,
      "x-api-key": `${CREDENTIAL_MARKER}-x-api-key`,
      "x-auth-token": `${CREDENTIAL_MARKER}-x-auth-token`,
      "x-partner-token": `${CREDENTIAL_MARKER}-partner`
    });
    expect(Object.isFrozen(compiled)).toBe(true);

    for (const vector of HOSTILE_HEADER_VECTORS) {
      let error: any;
      try {
        compileOutboundCredentialHeaders(vector.entries);
      } catch (caught: any) {
        error = caught;
      }
      expectPolicyDenial(error, vector.reasonCode);
    }
  });

  it("rejects hostile Secret writes and model bindings without changing active encrypted state", async () : Promise<any> => {
    const userDataPath: any = await temporaryRoot("meshrix-credential-header-write");
    const secretKeyProvider: any = createMemoryLocalSecretKeyProvider();
    cleanupTasks.push(() : any => secretKeyProvider.close());
    const baseUrl: any = "https://upstream.example.test";
    for (const vector of HOSTILE_HEADER_VECTORS) {
      const error: any = await captureRejection(initializeLocalSecret({
        dataDir: userDataPath,
        keyProvider: secretKeyProvider,
        payload: payloadFor(vector.entries),
        target: secretTarget(baseUrl)
      }));
      expectPolicyDenial(error, vector.reasonCode);
      await expect(listLocalSecretEntries({ dataDir: userDataPath })).resolves.toEqual([]);
    }

    await initializeLocalSecret({
      dataDir: userDataPath,
      keyProvider: secretKeyProvider,
      payload: payloadFor(ALLOWED_HEADER_ENTRIES),
      target: secretTarget(baseUrl)
    });
    const rotationError: any = await captureRejection(rotateLocalSecret({
      dataDir: userDataPath,
      expectedRevision: 1,
      keyProvider: secretKeyProvider,
      payload: payloadFor(HOSTILE_HEADER_VECTORS.at(-1).entries),
      target: secretTarget(baseUrl)
    }));
    expectPolicyDenial(rotationError, "header_name_duplicate");
    const resolved: any = await resolveLocalSecretPayload({
      dataDir: userDataPath,
      expectedRevision: 1,
      expectedScope: {
        serviceId: SERVICE_ID,
        requiredScopes: ["gateway:write"],
        host: "upstream.example.test",
        protocol: "https"
      },
      keyProvider: secretKeyProvider,
      secretRef: SECRET_REF
    });
    expect(resolved.revision).toBe(1);
    expect(resolved.payload).toEqual(payloadFor(ALLOWED_HEADER_ENTRIES));

    const agentRoot: any = await temporaryRoot("meshrix-model-header-binding");
    const agentRegistry: any = new AgentConfigRegistry({ rootPath: agentRoot });
    const accepted: any = safeAgent("https://model.example.test");
    await agentRegistry.replaceFromModelLibraryAgents([accepted]);
    const acceptedGeneration: any = agentRegistry.generation;
    for (const vector of HOSTILE_HEADER_VECTORS.filter((item?: any) : any => item.entries.length === 1)) {
      const [headerName, headerValue] = vector.entries[0];
      const patch: any = vector.reasonCode === "header_value_invalid"
        ? {
            tokenHeader: "Authorization",
            tokenPrefix: headerValue
          }
        : {
            tokenHeader: headerName
          };
      let normalizeError: any;
      try {
        normalizeAgentModelPayload(patch);
      } catch (caught: any) {
        normalizeError = caught;
      }
      expectPolicyDenial(normalizeError, vector.reasonCode);
      const bindingError: any = await captureRejection(
        agentRegistry.replaceFromModelLibraryAgents([{
          ...accepted,
          ...patch
        }])
      );
      expectPolicyDenial(bindingError, vector.reasonCode);
      expect(agentRegistry.generation).toBe(acceptedGeneration);
    }
    expect(agentRegistry.getModelLibraryAgents()).toEqual([
      expect.objectContaining({
        tokenHeader: "Authorization",
        uid: accepted.uid
      })
    ]);
  });

  it("sends each legal credential header exactly once through real structured, streaming, and model transports", async () : Promise<any> => {
    const fixture: any = await createGatewayFixture();
    const operation: any = fixture.descriptor.operations.find(
      (item?: any) : any => item.operationKey === "structured"
    );
    const material: any = await resolveCredentialMaterial({
      userDataPath: fixture.userDataPath,
      service: fixture.descriptor,
      operation,
      secretKeyProvider: fixture.secretKeyProvider,
      targetUrl: new URL(`${fixture.peer.baseUrl}/structured`)
    });
    expect(material.headers).toEqual({
      authorization: `Bearer ${CREDENTIAL_MARKER}`,
      "api-key": `${CREDENTIAL_MARKER}-api-key`,
      "x-api-key": `${CREDENTIAL_MARKER}-x-api-key`,
      "x-auth-token": `${CREDENTIAL_MARKER}-x-auth-token`,
      "x-partner-token": `${CREDENTIAL_MARKER}-partner`
    });

    await expect(forwardStructured(fixture.registry)).resolves.toMatchObject({
      ok: true,
      serviceId: SERVICE_ID
    });
    await expect(forwardStream(fixture.registry)).resolves.toMatchObject({
      responseBody: Buffer.from("stream-ok"),
      result: {
        ok: true,
        serviceId: SERVICE_ID
      }
    });
    await expect(callModel(
      safeAgent(fixture.peer.baseUrl),
      fixture.userDataPath
    )).resolves.toMatchObject({
      answer: "policy-ok"
    });

    expect(fixture.peer.requests.map((request?: any) : any => request.pathname)).toEqual([
      "/structured",
      "/stream",
      "/v1/chat/completions"
    ]);
    for (const request of fixture.peer.requests.slice(0, 2)) {
      for (const [name, value] of ALLOWED_HEADER_ENTRIES) {
        expect(headerValues(request.rawHeaders, name)).toEqual([value]);
      }
    }
    expect(headerValues(
      fixture.peer.requests[2].rawHeaders,
      "Authorization"
    )).toEqual([`Bearer ${CREDENTIAL_MARKER}`]);
  });

  it("revalidates every legacy encrypted Secret before resolver, structured, or streaming network use", async () : Promise<any> => {
    const fixture: any = await createGatewayFixture();
    const operation: any = fixture.descriptor.operations.find(
      (item?: any) : any => item.operationKey === "structured"
    );
    for (const vector of HOSTILE_HEADER_VECTORS) {
      await replaceWithLegacyEncryptedPayload({
        userDataPath: fixture.userDataPath,
        secretKeyProvider: fixture.secretKeyProvider,
        payload: payloadFor(vector.entries)
      });

      const resolveError: any = await captureRejection(resolveCredentialMaterial({
        userDataPath: fixture.userDataPath,
        service: fixture.descriptor,
        operation,
        secretKeyProvider: fixture.secretKeyProvider,
        targetUrl: new URL(`${fixture.peer.baseUrl}/structured`)
      }));
      expectCredentialUseDenial(resolveError, vector.reasonCode);

      const structuredError: any = await captureRejection(
        forwardStructured(fixture.registry)
      );
      expectCredentialUseDenial(structuredError, vector.reasonCode);

      const streamingError: any = await captureRejection(
        forwardStream(fixture.registry)
      );
      expectCredentialUseDenial(streamingError, vector.reasonCode);

      expect(fixture.peer.connectionCount(), vector.id).toBe(0);
      expect(fixture.peer.requests, vector.id).toHaveLength(0);
    }
  });

  it("revalidates hostile legacy model token headers immediately before transport use", async () : Promise<any> => {
    const peer: any = await startLoopbackPeer();
    const userDataPath: any = await temporaryRoot("meshrix-model-header-use");
    for (const vector of HOSTILE_HEADER_VECTORS.filter((item?: any) : any => item.entries.length === 1)) {
      const [headerName, headerValue] = vector.entries[0];
      const legacyAgent: any = safeAgent(peer.baseUrl, vector.reasonCode === "header_value_invalid"
        ? {
            tokenHeader: "Authorization",
            tokenPrefix: headerValue
          }
        : {
            tokenHeader: headerName
          });
      const error: any = await captureRejection(callModel(legacyAgent, userDataPath));
      expect(error).toMatchObject({
        code: "agent_gateway_credential_policy_denied",
        retryable: false,
        stage: "credential",
        cause: {
          code: "outbound_credential_header_policy_denied",
          reasonCode: vector.reasonCode
        }
      });
      expect(String(error.message || "")).not.toContain(CREDENTIAL_MARKER);
      expect(peer.connectionCount(), vector.id).toBe(0);
      expect(peer.requests, vector.id).toHaveLength(0);
    }

    await expect(callModel(
      safeAgent(peer.baseUrl),
      userDataPath
    )).resolves.toMatchObject({
      answer: "policy-ok"
    });
    expect(peer.requests).toHaveLength(1);
    expect(headerValues(peer.requests[0].rawHeaders, "Authorization"))
      .toEqual([`Bearer ${CREDENTIAL_MARKER}`]);
  });
});
