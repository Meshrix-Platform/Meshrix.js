import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createToolSkillManagementProvider } from "../../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { createOperationPermissionPlatform } from "../../../../packages/capabilities/src/operation-permission-core/index.ts";
import { dispatchOperation } from "../../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { createUpstreamGatewayRegistry, compileUpstreamOperationProjection } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { createPlatformMcpGateway } from "../../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { structuredUpstreamServiceFixture, installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";
import { modernHttpRequest } from "../support.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function createCapturedResponse(): Record<string, any> {
  return {
    chunks: [] as Buffer[],
    statusCode: 0,
    writeHead(statusCode: number) { this.statusCode = statusCode; },
    write(chunk: unknown) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk?: unknown) {
      this.write(chunk);
      this.ended = true;
    },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}"); }
  };
}

function operationProofSubstrate(): Record<string, any> {
  let nextId = 0;
  return {
    async beginLifecycle() { nextId += 1; return { ledgerEventId: `proof:configured-operation:${nextId}` }; },
    async finishLifecycle({ ledgerEventId }: Record<string, any>) { return { ledgerEventId }; },
    async recordReceipt() { nextId += 1; return { ledgerEventId: `proof:configured-operation:${nextId}` }; }
  };
}

describe("configured HTTP and JSON-RPC upstream publication", () => {
  it("publishes each configured operation once and executes through its Operation Permission sink", async () => {
    const serviceId = "configured-store";
    let state = "initial";
    let safeWriteEffects = 0;
    let rpcEffects = 0;
    const peerRequests: Array<{ method: string; path: string; body: any }> = [];
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      const requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
      peerRequests.push({ method: request.method || "", path: requestPath, body });
      let result: Record<string, any>;
      if (request.method === "GET" && requestPath === "/state") {
        result = { value: state };
      } else if (request.method === "POST" && requestPath === "/state") {
        state = String(body?.value || "");
        safeWriteEffects += 1;
        result = { value: state };
      } else if (request.method === "POST" && requestPath === "/rpc") {
        state = String(body?.params?.value || "");
        rpcEffects += 1;
        result = { jsonrpc: "2.0", id: body?.id, result: { value: state, effect: rpcEffects } };
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => peer.close((error) => error ? reject(error) : resolve())));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("configured-operation peer did not bind");

    const registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(), schemaPort: createGatewaySchemaPort() });
    cleanup.push(() => registry.close());
    installUpstreamRuntimeServices(registry, [structuredUpstreamServiceFixture({
      serviceId,
      serviceProtocol: "http",
      label: "Configured state store",
      baseUrl: `http://127.0.0.1:${address.port}`,
      allowLocalNetwork: true,
      operations: [
        {
          operationKey: "state.read",
          protocol: "http",
          method: "GET",
          path: "/state",
          risk: "read_only",
          requiredScopes: ["gateway:read"]
        },
        {
          operationKey: "state.write",
          protocol: "http",
          method: "POST",
          path: "/state",
          risk: "safe_write",
          requiredScopes: ["gateway:write"],
          requestSchema: {
            type: "object",
            properties: { value: { type: "string" }, body: { type: "string" } },
            required: ["value"],
            additionalProperties: false
          }
        },
        {
          operationKey: "state.rpc",
          protocol: "json-rpc",
          method: "POST",
          path: "/rpc",
          rpcMethod: "state.replace",
          risk: "safe_write",
          requiredScopes: ["gateway:write"],
          requestSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false
          }
        }
      ]
    })]);
    const projection = compileUpstreamOperationProjection(registry.captureManifestSnapshotState());
    const operationByToolId = new Map(projection.operations.map((operation: Record<string, any>) => [operation.toolId, operation]));
    const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-configured-operation-"));
    cleanup.push(() => fs.rm(operationRoot, { recursive: true, force: true }));
    const operationPermission = await createOperationPermissionPlatform({
      userDataPath: operationRoot,
      operations: [...projection.operations],
      featureRuntime: null,
      operationDispatcher: async () => ({ ok: true }),
      controllers: {}
    });
    cleanup.push(() => operationPermission.close());

    const fullGrant = {
      id: "configured-full-grant",
      revision: "configured-full-grant-r1",
      subjectId: "configured-caller",
      scopes: ["gateway:read", "gateway:write"],
      toolsets: [],
      dynamicCapabilities: projection.operations.map((operation: Record<string, any>) => operation._meta.dynamicCapability.capabilityId),
      allowedServiceIds: [serviceId],
      allowedSecretBindings: [],
      maxRisk: "safe_write"
    };
    const readGrant = {
      id: "configured-read-grant",
      revision: "configured-read-grant-r1",
      subjectId: "configured-caller",
      scopes: ["gateway:read"],
      toolsets: [],
      dynamicCapabilities: projection.operations
        .filter((operation: Record<string, any>) => operation.safety.risk === "read_only")
        .map((operation: Record<string, any>) => operation._meta.dynamicCapability.capabilityId),
      allowedServiceIds: [serviceId],
      allowedSecretBindings: [],
      maxRisk: "read_only"
    };
    let currentGrant: Record<string, any> = fullGrant;
    let denyAtFinalSink = false;
    const finalSinkDenials: Array<{ status: number; reasonCode: string }> = [];
    const proof = operationProofSubstrate();
    const permissionProvider = createToolSkillManagementProvider({
      operationPermissionPlatform: operationPermission,
      evaluateToolAudience: ({ authorization, tool, purpose }: Record<string, any>) => registry.evaluateProjectedOperationAudience({
        grant: authorization?.grant || null,
        restriction: authorization?.restriction || null,
        subject: authorization?.subject || null,
        tool: { ...tool, upstreamProjectedOperation: true },
        purpose
      })
    });

    function dispatchAuthorization(operation: Record<string, any>, grant: Record<string, any>, phase = "admission"): Record<string, any> {
      if (phase === "final-protected-sink" && denyAtFinalSink) {
        finalSinkDenials.push({ status: 403, reasonCode: "final_protected_sink_authority_revoked" });
        return { ok: false, status: 403, revoked: true, reasonCode: "final_protected_sink_authority_revoked" };
      }
      const risk = String(operation.safety?.risk || "unknown");
      const subject = {
        generation: "1",
        subjectId: grant.subjectId,
        tenantId: "configured-operation-tenant",
        type: "tool-grant"
      };
      const protectedContext = {
        approvalRevision: "none",
        grantRevision: String(grant.revision),
        policyRevision: "configured-operation-policy-r1",
        riskRevision: risk,
        workloadGeneration: "1"
      };
      return {
        ok: true,
        session: { sessionId: grant.id, user: { userId: grant.subjectId, subjectId: grant.subjectId, scopes: grant.scopes } },
        grant,
        authorizationDecision: { allowed: true, decisionId: `decision:${grant.revision}`, reasonCode: "fixture_allow" },
        protectedSinkAuthority: { subject, context: protectedContext }
      };
    }

    const toolProvider = {
      async authorizeMcpClientRequest() {
        return {
          ok: true,
          handled: true,
          credentialKind: "tool_grant",
          grant: currentGrant,
          subject: {
            type: "tool-grant",
            subjectId: currentGrant.subjectId,
            grantId: currentGrant.id,
            scopes: currentGrant.scopes,
            dynamicCapabilities: currentGrant.dynamicCapabilities,
            allowedServiceIds: currentGrant.allowedServiceIds,
            maxRisk: currentGrant.maxRisk
          }
        };
      },
      listVisibleTools(input: Record<string, any>) { return permissionProvider.listVisibleTools(input); },
      async executeTool({ toolId, input, authorization, signal }: Record<string, any>) {
        const operation = operationByToolId.get(String(toolId));
        if (!operation) return { ok: false, status: 404, payload: { error: { code: "operation_not_found" } } };
        const grant = authorization?.grant || currentGrant;
        const authSession = { sessionId: grant.id, user: { userId: grant.subjectId, subjectId: grant.subjectId, scopes: grant.scopes } };
        const response = createCapturedResponse();
        const request = { method: "POST", headers: {} };
        try {
          await dispatchOperation({
            actor: authSession.user,
            authSession,
            authorizeOperation: async () => dispatchAuthorization(operation, grant),
            revalidateAuthorization: async ({ phase }: Record<string, any>) => dispatchAuthorization(operation, grant, phase),
            controllers: {
              system: {
                async handleUpstreamGatewayOperation({ operation: dispatchedOperation, input: operationInput, response: dispatchResponse, finalProtectedSinkPermit, signal: dispatchSignal }: Record<string, any>) {
                  const forwarded = await registry.forwardProjectedOperation(dispatchedOperation.id, operationInput, {
                    type: "tool-grant",
                    subjectId: grant.subjectId,
                    grantId: grant.id,
                    scopes: grant.scopes,
                    dynamicCapabilities: grant.dynamicCapabilities,
                    allowedServiceIds: grant.allowedServiceIds
                  }, { finalProtectedSinkPermit, signal: dispatchSignal });
                  dispatchResponse.writeHead(forwarded.upstream.status, { "content-type": "application/json" });
                  dispatchResponse.end(JSON.stringify({ ok: forwarded.ok, response: forwarded.response }));
                }
              }
            },
            input,
            operation,
            operationProofSubstrate: proof,
            request,
            requestBody: Buffer.from(JSON.stringify(input)),
            response,
            signal,
            transport: "mcp",
            method: "POST",
            url: new URL(`http://127.0.0.1${operation.http.path}`),
            logger: { debug() {}, info() {}, warn() {}, error() {} }
          });
        } catch (error: any) {
          return { ok: false, status: Number(error?.status || error?.statusCode || 502), payload: { error: { code: String(error?.code || "operation_dispatch_failed") } } };
        }
        if (response.statusCode >= 400) {
          return { ok: false, status: response.statusCode, payload: { error: response.json() } };
        }
        const captured = response.json();
        return {
          ok: captured.ok === true,
          status: response.statusCode || 200,
          payload: { result: { resultType: "complete", structuredContent: captured.response } }
        };
      }
    };

    const platform = createPlatformMcpGateway({ upstreamGatewayRegistry: registry, toolSkillManagementProvider: toolProvider });
    cleanup.push(() => platform.close());
    await platform.gateway.start();

    let requestId = 0;
    const send = (method: string, params: Record<string, unknown> = {}) => platform.adapter.handle(modernHttpRequest(method, `${method}-${++requestId}`, params));
    const listTools = async () => {
      const page = await send("tools/list");
      return (page.body as { result: { tools: Array<Record<string, any>> } }).result.tools;
    };
    const fullTools = await listTools();
    const published = fullTools.filter((tool) => tool._meta?.serviceId === serviceId);
    const expectedNames = projection.operations.map((operation: Record<string, any>) => operation.toolId).sort();
    expect(published.map((tool) => tool.name).sort()).toEqual(expectedNames);
    const readPublicName = projection.operations.find((operation: Record<string, any>) => operation._meta.operationKey === "state.read").toolId;
    expect(published.find((tool) => tool.name === readPublicName)?.inputSchema).toEqual({ type: "object" });
    const writePublicName = projection.operations.find((operation: Record<string, any>) => operation._meta.operationKey === "state.write").toolId;
    const writeInputSchema = published.find((tool) => tool.name === writePublicName)?.inputSchema;
    expect(writeInputSchema).toEqual({
      type: "object",
      properties: { value: { type: "string" }, body: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    });
    expect((await registry.listMcpTools({ serviceId })).items).toEqual([]);
    await expect(registry.callMcpToolByPublicName(writePublicName, { arguments: { value: "bypass" } }))
      .rejects.toMatchObject({ status: 404 });
    expect(peerRequests).toHaveLength(0);

    const byKey = new Map(projection.operations.map((operation: Record<string, any>) => [operation._meta.operationKey, operation.toolId]));
    const readTool = byKey.get("state.read");
    const writeTool = byKey.get("state.write");
    const rpcTool = byKey.get("state.rpc");
    const read = async () => send("tools/call", { name: readTool, arguments: {} });
    const call = (name: string, value: string, extra: Record<string, unknown> = {}) => send("tools/call", { name, arguments: { value, ...extra } });
    const expectConfiguredResult = (response: Record<string, any>, toolId: string, json: Record<string, any>) => {
      expect(response).toMatchObject({
        status: 200,
        body: {
          result: {
            resultType: "complete",
            structuredContent: {
              value: {
                operation: toolId,
                upstreamConfiguredOperation: true,
                payload: { resultType: "complete", structuredContent: { json } }
              }
            }
          }
        }
      });
      expect(response.body.result.isError).not.toBe(true);
    };

    const beforeInvalidWrite = peerRequests.length;
    const invalidWrite = await send("tools/call", { name: writeTool, arguments: {} });
    expect(invalidWrite).toMatchObject({ status: 200, body: { error: { data: { code: "schema_validation_failed", effectOutcome: "not_started" } } } });
    expect(peerRequests).toHaveLength(beforeInvalidWrite);
    const invalidAdditionalField = await send("tools/call", { name: writeTool, arguments: { value: "invalid", extra: true } });
    expect(invalidAdditionalField).toMatchObject({ status: 200, body: { error: { data: { code: "schema_validation_failed", effectOutcome: "not_started" } } } });
    expect(peerRequests).toHaveLength(beforeInvalidWrite);

    expectConfiguredResult(await read(), readTool, { value: "initial" });
    expectConfiguredResult(await call(writeTool, "http-updated", { body: "business-field" }), writeTool, { value: "http-updated" });
    expect(peerRequests.find((request) => request.path === "/state" && request.method === "POST")?.body).toEqual({ value: "http-updated", body: "business-field" });
    expectConfiguredResult(await read(), readTool, { value: "http-updated" });
    expectConfiguredResult(await call(rpcTool, "rpc-updated"), rpcTool, { jsonrpc: "2.0", result: { value: "rpc-updated", effect: 1 } });
    expectConfiguredResult(await read(), readTool, { value: "rpc-updated" });
    expect(peerRequests.filter((request) => request.method === "POST" && request.path === "/state")).toHaveLength(1);
    expect(peerRequests.find((request) => request.path === "/rpc")?.body).toMatchObject({ method: "state.replace", params: { value: "rpc-updated" } });
    expect(safeWriteEffects).toBe(1);
    expect(rpcEffects).toBe(1);

    currentGrant = readGrant;
    const readOnlyTools = (await listTools()).filter((tool) => tool._meta?.serviceId === serviceId);
    expect(readOnlyTools.map((tool) => tool.name)).toEqual([readTool]);
    const beforeDeniedCall = peerRequests.length;
    const deniedWrite = await call(writeTool, "must-not-run");
    expect(deniedWrite).toMatchObject({
      status: 403,
      body: { error: { data: { code: "tool_not_published", effectOutcome: "not_started" } } }
    });
    expect(peerRequests).toHaveLength(beforeDeniedCall);
    expect(state).toBe("rpc-updated");

    currentGrant = fullGrant;
    await listTools();
    denyAtFinalSink = true;
    const beforeRevokedCall = peerRequests.length;
    const revokedWrite = await call(writeTool, "revoked-before-send");
    expect(finalSinkDenials).toEqual([{ status: 403, reasonCode: "final_protected_sink_authority_revoked" }]);
    expect(revokedWrite).toMatchObject({
      status: 200,
      body: {
        result: {
          resultType: "complete",
          isError: true,
          structuredContent: {
            value: { operation: writeTool, payload: { error: { code: "operation_outcome_in_doubt" } } }
          }
        }
      }
    });
    expect(peerRequests).toHaveLength(beforeRevokedCall);
    expect(state).toBe("rpc-updated");
  });
});
