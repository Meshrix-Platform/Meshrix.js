import { describe, expect, it, vi } from "vitest";
import {
  OPERATION_PROOF_PROFILES,
  decorateServerApiOperations
} from "#meshrix/contracts/operations/operation-decorators";
import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { createCorePlatformProvider } from "#meshrix/server-runtime/composition/core-platform-provider";
import {
  dispatchOperation,
  dispatchRpcOperation,
  findProxyRegisteredApiRequest,
  shouldProxyRegisteredApiRequest
} from "#meshrix/server-runtime/composition/dispatch-operation";

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      const lowerName = String(name || "").toLowerCase();
      const entry = Object.entries(this.headers).find(([headerName]) => headerName.toLowerCase() === lowerName);
      return entry?.[1];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    },
    text() {
      return Buffer.concat(this.chunks).toString("utf8");
    }
  };
}

function baseOperation(overrides = {}) {
  return {
    id: "unit.dispatch",
    target: { controller: "unit", method: "handle" },
    http: { method: "POST", path: "/api/unit/dispatch" },
    concurrencySafe: true,
    readOnly: true,
    safety: { risk: "read_only" },
    audit: { enabled: false },
    log: { recordInput: false },
    inputSchema: { type: "object", properties: {} },
    ...overrides
  };
}

function controllers(handler) {
  return {
    unit: {
      handle: handler
    }
  };
}

async function dispatchTestOperation({
  operation,
  operationControllers,
  input = {},
  ...options
}) {
  const response = createResponse();
  const outcome = await dispatchOperation({
    operation,
    controllers: operationControllers,
    request: {},
    response,
    input,
    url: new URL(operation.http.path, "http://127.0.0.1"),
    transport: "internal",
    skipAuthorization: true,
    revalidateAuthorization: vi.fn(async () => ({ ok: true })),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...options
  });
  return { outcome, response };
}

describe("operation dispatcher behavior", () => {
  it("coerces the context build-record limit before schema validation", async () => {
    const operation = SERVER_API_OPERATIONS.find(({ id }) => id === "context.build_records");
    expect(operation?.http?.coerce).toEqual({ limit: "number" });

    const response = createResponse();
    const handler = vi.fn(({ input, response: innerResponse }) => {
      expect(input.limit).toBe(20);
      innerResponse.writeHead(200, { "Content-Type": "application/json" });
      innerResponse.end(JSON.stringify({ records: [] }));
    });

    await expect(dispatchOperation({
      operation,
      controllers: {
        system: {
          handleContextBuildRecords: handler
        }
      },
      request: {},
      response,
      requestBody: Buffer.alloc(0),
      url: new URL("http://127.0.0.1/api/context/build-records?limit=20"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: true, statusCode: 200 });
    expect(handler).toHaveBeenCalledOnce();
    expect(response.json()).toEqual({ records: [] });
  });

  it("keeps the workspace asset console query and submit payload aligned with the contract", async () => {
    const listOperation = SERVER_API_OPERATIONS.find(({ id }) => id === "workspace.asset.list");
    const submitOperation = SERVER_API_OPERATIONS.find(({ id }) => id === "workspace.asset.submit");
    expect(listOperation?.http?.coerce).toEqual({ limit: "number" });
    expect(submitOperation?.inputSchema?.properties?.overwrite).toEqual({ type: "boolean" });

    const response = createResponse();
    const release = vi.fn(async () => {});
    const lockManager = {
      config: { defaultTtlMs: 10_000, heartbeatIntervalMs: 5_000 },
      acquire: vi.fn(async (lockKey) => ({
        lockKey,
        fencingToken: "workspace-asset-submit-fixture",
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 10_000),
        released: false,
        heartbeat: vi.fn(async () => {}),
        release
      }))
    };
    const handler = vi.fn(({ input, response: innerResponse }) => {
      expect(input).toMatchObject({
        workspaceId: "workspace-demo",
        submitKind: "file",
        overwrite: false
      });
      innerResponse.writeHead(201, { "Content-Type": "application/json" });
      innerResponse.end(JSON.stringify({ ok: true }));
    });
    await expect(dispatchOperation({
      operation: submitOperation,
      controllers: {
        system: {
          handleWorkspaceAssetSubmit: handler
        }
      },
      request: {},
      response,
      lockManager,
      input: {
        workspaceId: "workspace-demo",
        submitKind: "file",
        target: { kind: "workspace", path: "demo.txt" },
        content: { content: "synthetic" },
        policy: {},
        overwrite: false
      },
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: { user: { scopes: ["workspace:write"] } },
        authorizationDecision: { allowed: true, decisionId: "workspace-submit-test" }
      })),
      revalidateAuthorization: vi.fn(async () => ({ ok: true })),
      url: new URL("http://127.0.0.1/api/workspace/assets/submit"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: true, statusCode: 201 });
    expect(handler).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("declares the complete console checkpoint restore payload for preview and apply", () => {
    for (const operationId of [
      "workspace.checkpoint.restore.preview",
      "workspace.checkpoint.restore"
    ]) {
      const operation = SERVER_API_OPERATIONS.find(({ id }) => id === operationId);
      expect(operation?.inputSchema).toMatchObject({
        required: ["treeId", "nodeId"],
        additionalProperties: false,
        properties: {
          treeId: { type: "string" },
          nodeId: { type: "string" },
          workspaceId: { type: "string" },
          mode: { type: "string" },
          reason: { type: "string" }
        }
      });
    }
  });

  it("keeps tag, queue control, and tool policy console payloads aligned with their contracts", () => {
    const tagUpsert = SERVER_API_OPERATIONS.find(({ id }) => id === "tag_management.tags.upsert");
    expect(tagUpsert?.inputSchema?.properties?.enabled).toEqual({ type: "boolean" });

    for (const operationId of [
      "jobs.work_queue.pause",
      "jobs.work_queue.resume",
      "jobs.work_queue.drain"
    ]) {
      const operation = SERVER_API_OPERATIONS.find(({ id }) => id === operationId);
      expect(operation?.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: { reason: { type: "string" } }
      });
    }

    const policyPreview = SERVER_API_OPERATIONS.find(
      ({ id }) => id === "operation_permission.policy_preview"
    );
    expect(policyPreview?.inputSchema).toMatchObject({
      required: ["toolId", "input"],
      additionalProperties: false,
      properties: {
        toolId: { type: "string" },
        input: { type: "object" },
        dryRun: { type: "boolean" },
        grantId: { type: "string" },
        grant: { type: "object" },
        profileId: { type: "string" },
        context: { type: "object" }
      }
    });

    const assemblyBuild = SERVER_API_OPERATIONS.find(({ id }) => id === "runtime.assembly.build");
    expect(assemblyBuild?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        selectedComponentIds: { type: "array", items: { type: "string" } },
        componentIds: { type: "array", items: { type: "string" } },
        components: { type: "array", items: { type: "string" } }
      }
    });
  });

  it("lets write-capable operations marked concurrencySafe use their own runtime concurrency policy", async () => {
    const operation = baseOperation({
      id: "unit.concurrent.write",
      readOnly: false,
      concurrencySafe: true,
      safety: { risk: "safe_write" },
      requiredScopes: [],
      rpc: { method: "unit.concurrent.write" }
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const lockManager = { acquire: vi.fn() };
    const operationControllers = controllers(async ({ response }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
    });

    const [left, right] = await Promise.all([
      dispatchTestOperation({
        operation,
        operationControllers,
        lockManager
      }),
      dispatchTestOperation({
        operation,
        operationControllers,
        lockManager
      })
    ]);

    expect(left.outcome.statusCode).toBe(200);
    expect(right.outcome.statusCode).toBe(200);
    expect(lockManager.acquire).not.toHaveBeenCalled();
    expect(maxInFlight).toBe(2);
  });

  it("covers validation, empty parsing, malformed parsing, and proxy edge branches", async () => {
    await expect(dispatchOperation({})).rejects.toThrow("dispatchOperation requires an operation.");

    expect(shouldProxyRegisteredApiRequest({
      pathname: "/console",
      discoveryState: { mode: "forward", forwardBaseUrl: "https://upstream.local" },
      operations: []
    })).toBe(false);
    expect(findProxyRegisteredApiRequest({
      method: "POST",
      pathname: "/api/workspaces/workspace-a/proxy",
      discoveryState: {
        mode: "forward",
        advertisedBaseUrl: "https://local.example",
        forwardBaseUrl: "https://upstream.local"
      },
      operations: [baseOperation({
        http: { method: "POST", path: "/api/workspaces/:workspaceId/proxy" }
      })]
    })).toMatchObject({
      pathParams: { workspaceId: "workspace-a" },
      targetBaseUrl: "https://upstream.local"
    });

    const okResponse = createResponse();
    await expect(dispatchOperation({
      operation: baseOperation({ inputSchema: { type: "string" } }),
      controllers: controllers(({ response }) => {
        response.writeHead(204, {});
        response.end();
      }),
      request: {},
      response: okResponse,
      requestBody: Buffer.alloc(0),
      url: new URL("http://127.0.0.1/api/unit/dispatch"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: true, statusCode: 204 });

    const arrayResponse = createResponse();
    await expect(dispatchOperation({
      operation: baseOperation(),
      controllers: controllers(() => {}),
      request: {},
      response: arrayResponse,
      input: [],
      url: new URL("http://127.0.0.1/api/unit/dispatch"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: false, statusCode: 400 });
    expect(arrayResponse.json().error).toContain("requires object input");

    const typeResponse = createResponse();
    await expect(dispatchOperation({
      operation: baseOperation({
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" } }
        }
      }),
      controllers: controllers(() => {}),
      request: {},
      response: typeResponse,
      input: { count: "3" },
      url: new URL("http://127.0.0.1/api/unit/dispatch"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: false, statusCode: 400 });
    expect(typeResponse.json().error).toContain("count must be number");

    const protocolResponse = createResponse();
    await expect(dispatchOperation({
      operation: baseOperation({
        http: {
          method: "POST",
          path: "/api/unit/protocol",
          schemaError: {
            status: 400,
            code: "unit_request_schema_invalid",
            responseBase: {
              ok: false,
              schemaVersion: "unit.schema",
              protocolVersion: "unit.protocol"
            }
          }
        },
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["count"],
          properties: { count: { type: "integer", minimum: 1 } }
        }
      }),
      controllers: controllers(() => {}),
      request: {},
      response: protocolResponse,
      input: { count: 0 },
      url: new URL("http://127.0.0.1/api/unit/protocol"),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toMatchObject({ ok: false, statusCode: 400 });
    expect(protocolResponse.json()).toMatchObject({
      ok: false,
      schemaVersion: "unit.schema",
      protocolVersion: "unit.protocol",
      code: "unit_request_schema_invalid"
    });

    for (const requestBody of ["   ", "{not-json", { direct: true }]) {
      const response = createResponse();
      await expect(dispatchOperation({
        operation: baseOperation(),
        controllers: controllers(({ response: innerResponse }) => {
          innerResponse.writeHead(200, { "Content-Type": "application/json" });
          innerResponse.end(JSON.stringify({ ok: true }));
        }),
        request: {},
        response,
        requestBody,
        url: new URL("http://127.0.0.1/api/unit/dispatch"),
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })).resolves.toMatchObject({ ok: true });
    }
  });

  it("captures fixed startup snapshot text and binary responses with case-insensitive headers", async () => {
    const textOperation = baseOperation({
      id: "system.interfaces",
      http: { method: "POST", path: "/api/unit/text" }
    });
    const textPort = createCorePlatformProvider({
      operations: [textOperation],
    }).createStartupSnapshotPort({
      controllers: controllers(({ response }) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        expect(response.getHeader("content-type")).toBe("text/plain; charset=utf-8");
        response.end("hello");
      })
    });
    expect(Object.keys(textPort)).toEqual([
      "readSystemInterfaces",
      "readDiscoveryConfig",
      "readAgentSyncConfig",
      "readConsoleState",
      "readStorageSummary"
    ]);
    expect(textPort).not.toHaveProperty("dispatch");
    expect(textPort).not.toHaveProperty("operationId");
    await expect(textPort.readSystemInterfaces()).resolves.toEqual({
      contentType: "text/plain; charset=utf-8",
      text: "hello"
    });

    const binaryOperation = baseOperation({
      id: "storage.summary",
      http: { method: "POST", path: "/api/unit/binary" },
      binary: true
    });
    const binaryPort = createCorePlatformProvider({
      operations: [binaryOperation],
    }).createStartupSnapshotPort({
      controllers: controllers(({ response }) => {
        response.writeHead(206, { "Content-Type": "application/octet-stream" });
        response.write(Buffer.from([1, 2, 3]));
      })
    });
    await expect(binaryPort.readStorageSummary()).resolves.toMatchObject({
      contentType: "application/octet-stream",
      byteLength: 3,
      base64: "AQID"
    });
  });

  it("maps RPC body encodings, URL params, query aliases, and error responses", async () => {
    const observations = [];
    const operation = baseOperation({
      id: "unit.rpc.echo",
      http: { method: "POST", path: "/api/rpc/echo" },
      rpc: {
        method: "unit.rpc.echo",
        syntheticPath: "/api/rpc/:id/:missing",
        params: [{ name: "id", aliases: ["itemId"], type: "string" }],
        query: [{ name: "tag", aliases: ["tags"] }, { name: "empty" }]
      }
    });
    const rpcControllers = controllers(({ requestBody, url, response }) => {
      observations.push({
        body: requestBody.toString("utf8"),
        pathname: url.pathname,
        tags: url.searchParams.getAll("tag")
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(observations.at(-1)));
    });
    const allowRpcOperation = vi.fn(async () => ({ ok: true }));

    const encodedResponse = createResponse();
    await dispatchRpcOperation({
      operations: [operation],
      controllers: rpcControllers,
      request: {},
      response: encodedResponse,
      authorizeOperation: allowRpcOperation,
      requestBody: Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "unit.rpc.echo",
        params: {
          itemId: "space value",
          bodyBase64: Buffer.from("from-base64").toString("base64"),
          tags: ["a", "b"]
        }
      })),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(encodedResponse.json().result).toMatchObject({
      body: "from-base64",
      pathname: "/api/rpc/space%20value/:missing",
      tags: ["a", "b"]
    });

    for (const params of [
      { itemId: "body-text", bodyText: "from-text" },
      { itemId: "body-string", body: "from-string" },
      { itemId: "empty-body" }
    ]) {
      const response = createResponse();
      await dispatchRpcOperation({
        operations: [operation],
        controllers: rpcControllers,
        request: {},
        response,
        authorizeOperation: allowRpcOperation,
        requestBody: Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: params.itemId,
          method: "unit.rpc.echo",
          params
        })),
        logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });
      expect(response.statusCode).toBe(200);
    }
    expect(observations.map((item) => item.body)).toEqual([
      "from-base64",
      "from-text",
      "from-string",
      ""
    ]);

    const failingOperation = baseOperation({
      id: "unit.rpc.failing",
      http: { method: "POST", path: "/api/rpc/failing" },
      rpc: { method: "unit.rpc.failing" }
    });
    const failedResponse = createResponse();
    await dispatchRpcOperation({
      operations: [failingOperation],
      controllers: controllers(({ response }) => {
        response.writeHead(422, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "bad rpc input", detail: true }));
      }),
      request: {},
      response: failedResponse,
      authorizeOperation: allowRpcOperation,
      requestBody: Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "unit.rpc.failing",
        params: {}
      })),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(failedResponse.json().error).toMatchObject({
      code: 422,
      message: "bad rpc input"
    });

    const requiredOperation = baseOperation({
      id: "unit.rpc.required",
      http: { method: "POST", path: "/api/rpc/required" },
      rpc: {
        method: "unit.rpc.required",
        params: [{ name: "id", required: true }]
      }
    });
    const requiredResponse = createResponse();
    await dispatchRpcOperation({
      operations: [requiredOperation],
      controllers: controllers(() => {}),
      request: {},
      response: requiredResponse,
      requestBody: Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: "missing",
        method: "unit.rpc.required",
        params: {}
      })),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(requiredResponse.json().error.code).toBe(500);
  });

  it("keeps raw JSON RPC carriers out of operation proof input", async () => {
    const marker = "synthetic-sensitive-marker";
    const proofInputs = [];
    const operationProofSubstrate = {
      beginLifecycle: vi.fn(async (input) => {
        proofInputs.push(input);
        return { ledgerEventId: "proof-entry" };
      }),
      finishLifecycle: vi.fn(async () => ({ ok: true }))
    };
    const operation = baseOperation({
      id: "unit.rpc.raw-json",
      readOnly: false,
      requiredScopes: [],
      safety: { risk: "safe_write" },
      http: { method: "POST", path: "/api/raw/:serviceId", rawJsonBytes: true },
      rpc: {
        method: "unit.rpc.raw-json",
        syntheticPath: "/api/raw/:serviceId",
        params: [{ name: "serviceId", required: true }]
      }
    });
    const response = createResponse();

    await dispatchRpcOperation({
      operations: [operation],
      controllers: controllers(({ requestBody, response: targetResponse }) => {
        expect(requestBody.toString("utf8")).toContain(marker);
        targetResponse.writeHead(200, { "Content-Type": "application/json" });
        targetResponse.end(JSON.stringify({ ok: true }));
      }),
      request: {},
      response,
      authorizeOperation: vi.fn(async () => ({ ok: true })),
      operationProofSubstrate,
      requestBody: Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: "raw-json",
        method: "unit.rpc.raw-json",
        params: {
          serviceId: "svc_fixture",
          bodyText: JSON.stringify({ description: marker })
        }
      })),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(response.statusCode).toBe(200);
    expect(proofInputs).toHaveLength(1);
    expect(proofInputs[0].input).toEqual({ serviceId: "svc_fixture" });
    expect(JSON.stringify(proofInputs)).not.toContain(marker);
    expect(JSON.stringify(proofInputs)).not.toContain("bodyText");
  });

  it("normalizes proof profiles without retaining the retired binding contract", () => {
    const definitions = [
      baseOperation({
        id: "unit.profile.read",
        http: { method: "GET", path: "/api/unit/profile/read" },
        rpc: { method: "unit.profile.read" },
        requiredScopes: ["console:read"]
      }),
      baseOperation({
        id: "unit.profile.write",
        readOnly: false,
        safety: { risk: "safe_write" },
        audit: { enabled: true },
        http: { method: "POST", path: "/api/unit/profile/write" },
        rpc: { method: "unit.profile.write" },
        requiredScopes: ["runtime:write"]
      })
    ];
    const [readOperation, writeOperation] = decorateServerApiOperations(definitions);

    expect(readOperation.proof).toMatchObject({ profile: OPERATION_PROOF_PROFILES.RECEIPT });
    expect(writeOperation.proof).toMatchObject({ profile: OPERATION_PROOF_PROFILES.FULL });
    expect(readOperation.proof).not.toHaveProperty("binding");
    expect(writeOperation.proof).not.toHaveProperty("binding");
    expect(SERVER_API_OPERATIONS.find((operation) => operation.id === "system.console_state")?.proof).toMatchObject({
      profile: OPERATION_PROOF_PROFILES.ON_CHANGE,
      changeProjection: "console-state-v1"
    });
    expect(() => decorateServerApiOperations([definitions[0], {
      ...definitions[1],
      id: "unit.profile.invalid-exclusion",
      http: { method: "POST", path: "/api/unit/profile/invalid-exclusion" },
      rpc: { method: "unit.profile.invalid-exclusion" },
      proof: { profile: OPERATION_PROOF_PROFILES.EXCLUDED }
    }])).toThrow("proof exclusion missing reason");
  });

  it("records one terminal receipt for read-only operations without starting a full lifecycle", async () => {
    const operation = baseOperation({
      id: "unit.profile.receipt",
      proof: { profile: OPERATION_PROOF_PROFILES.RECEIPT }
    });
    const operationProofSubstrate = {
      beginLifecycle: vi.fn(),
      finishLifecycle: vi.fn(),
      recordReceipt: vi.fn(async (input) => ({
        disposition: "recorded",
        ledgerEventId: "receipt-entry",
        input
      }))
    };

    await dispatchTestOperation({
      operation,
      operationControllers: controllers(({ response }) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ privateValue: "not-proof-input" }));
      }),
      operationProofSubstrate
    });

    expect(operationProofSubstrate.beginLifecycle).not.toHaveBeenCalled();
    expect(operationProofSubstrate.finishLifecycle).not.toHaveBeenCalled();
    expect(operationProofSubstrate.recordReceipt).toHaveBeenCalledTimes(1);
    const receipt = operationProofSubstrate.recordReceipt.mock.calls[0][0];
    expect(receipt).toMatchObject({ profile: "receipt", operationId: operation.id, status: "succeeded" });
    expect(JSON.stringify(receipt)).not.toContain("privateValue");
    expect(JSON.stringify(receipt)).not.toContain("not-proof-input");
  });

  it("records on-change receipts only from an explicit privacy-safe digest projection", async () => {
    const secret = "private-console-payload";
    const digest = `sha256:${"a".repeat(64)}`;
    const operation = baseOperation({
      id: "unit.profile.on-change",
      proof: {
        profile: OPERATION_PROOF_PROFILES.ON_CHANGE,
        changeProjection: "console-state-v1"
      }
    });
    const recordReceipt = vi.fn(async () => ({ disposition: "recorded", ledgerEventId: "change-entry" }));

    await dispatchTestOperation({
      operation,
      operationControllers: controllers(({ response }) => {
        response.__licoProofChangeProjection = {
          changeProjection: "console-state-v1",
          changeDigest: digest,
          changed: false
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ secret }));
      }),
      operationProofSubstrate: { recordReceipt }
    });

    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt.mock.calls[0][0]).toMatchObject({
      profile: "on-change",
      changeKey: "console-state-v1",
      changeProjection: "console-state-v1",
      changeDigest: digest
    });
    expect(JSON.stringify(recordReceipt.mock.calls[0][0])).not.toContain(secret);

    recordReceipt.mockClear();
    await dispatchTestOperation({
      operation,
      operationControllers: controllers(({ response }) => {
        response.writeHead(200, {});
        response.end();
      }),
      operationProofSubstrate: { recordReceipt }
    });
    expect(recordReceipt).not.toHaveBeenCalled();
  });

  it("forces denied on-change operations to a receipt and keeps metadata-only audit payloads empty", async () => {
    const operation = baseOperation({
      id: "unit.profile.on-change-denied",
      proof: {
        profile: OPERATION_PROOF_PROFILES.ON_CHANGE,
        changeProjection: "console-state-v1"
      },
      audit: {
        enabled: true,
        write: false,
        metadataOnly: true,
        recordInput: true,
        recordOutput: true
      },
      inputSchema: {
        type: "object",
        properties: { count: { type: "number" } }
      }
    });
    const response = createResponse();
    const operationAuditStore = {
      append: vi.fn(() => ({ auditId: "denied-audit" }))
    };
    const recordReceipt = vi.fn(async () => ({ disposition: "recorded", ledgerEventId: "denied-receipt" }));

    const dispatchResult = await dispatchOperation({
      operation,
      controllers: controllers(() => {}),
      request: {},
      response,
      input: { count: "private-invalid-value" },
      url: new URL("http://127.0.0.1/api/unit/profile/on-change-denied"),
      operationAuditStore,
      operationProofSubstrate: { recordReceipt },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(dispatchResult).toMatchObject({ ok: false, statusCode: 400 });
    expect(recordReceipt).toHaveBeenCalledTimes(1);
    expect(recordReceipt.mock.calls[0][0]).toMatchObject({
      profile: "receipt",
      status: "denied",
      denied: true,
      auditId: "denied-audit"
    });
    expect(operationAuditStore.append).toHaveBeenCalledTimes(1);
    expect(operationAuditStore.append.mock.calls[0][0]).toMatchObject({ input: {} });
    expect(operationAuditStore.append.mock.calls[0][0].output).toBeUndefined();
    expect(dispatchResult.riskControl.gateRecords.at(-1)?.reasonCode).toBe("audit_operation_recorded");
  });

  it("suppresses only successful audit rows when audit.write is false", async () => {
    const operation = baseOperation({
      id: "unit.audit.success-suppressed",
      proof: { profile: OPERATION_PROOF_PROFILES.RECEIPT },
      audit: { enabled: true, write: false, metadataOnly: true }
    });
    const response = createResponse();
    const operationAuditStore = { append: vi.fn() };

    const dispatchResult = await dispatchOperation({
      operation,
      controllers: controllers(({ response: targetResponse }) => {
        targetResponse.writeHead(200, {});
        targetResponse.end();
      }),
      request: {},
      response,
      input: {},
      url: new URL("http://127.0.0.1/api/unit/audit-success"),
      operationAuditStore,
      operationProofSubstrate: {
        recordReceipt: vi.fn(async () => ({ disposition: "recorded", ledgerEventId: "audit-receipt" }))
      },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });

    expect(operationAuditStore.append).not.toHaveBeenCalled();
    expect(dispatchResult.riskControl.gateRecords.at(-1)?.reasonCode).toBe("audit_success_suppressed");
  });
});
