import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { useConsoleApiKeyDistributionController } from "../../../../apps/console/composables/console-api-key-distribution-controller.ts";
import { createOperationPermissionPlatform } from "../../../../packages/capabilities/src/operation-permission-core/index.ts";
import { OPERATION_REGISTRY_GOVERNED_DEFINITIONS } from "../../../../packages/contracts/src/operations/operation-registry-governed-definitions.ts";
import { API_KEY_MANAGEMENT_ACTION } from "../../../../packages/foundation/src/security/authorization/api-key-issuer-authority.ts";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import { createOperationProofSubstrate } from "../../../../packages/foundation/src/proof/proof-substrate/index.ts";
import { createSystemControllerFoundationHandlers } from "../../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import { createToolSkillManagementProvider } from "../../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { executeConsoleDomainOperation } from "../../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { createPlatformMcpGateway } from "../../../../packages/server-runtime/src/composition/gateway-composition.ts";
import { dispatchOperation } from "../../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import { readAuthorizedMcpToolSelection } from "../../../../packages/server-runtime/src/composition/server-runtime-providers.ts";
import { compileUpstreamOperationProjection, createUpstreamGatewayRegistry } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";
import { modernHttpRequest } from "../support.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function capturedResponse(): Record<string, any> {
  return {
    chunks: [] as Buffer[],
    statusCode: 0,
    writeHead(statusCode: number) { this.statusCode = statusCode; },
    setHeader() {},
    write(chunk: unknown) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk?: unknown) {
      this.write(chunk);
      this.ended = true;
    },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}"); },
  };
}

function issuerSecurityPermissions(): Record<string, any> {
  const roles = [{
    roleId: "key-manager",
    name: "Key manager",
    scopeNodeId: "issuer",
    scopeNodeType: "organization",
    managementActions: [API_KEY_MANAGEMENT_ACTION],
  }];
  const nodes = [
    { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
    { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" },
  ];
  return {
    getOrganizationGovernance: () => ({ configured: true, revision: 1, nodes, roles }),
    getGovernanceSummary: () => ({
      policyRevision: { revision: 1, updatedAt: "2026-08-03T00:00:00.000Z" },
      roles: roles.map((role) => ({ ...role, enabled: true })),
      userPolicies: [{ userId: "issuer-admin", enabled: true, roleIds: ["key-manager"] }],
      apiKeyRecoveryAssignments: [],
    }),
    getGovernancePolicyRevision: () => ({ revision: 1 }),
    authorizeOperation: async () => ({
      ok: true,
      status: 200,
      session: { sessionId: "issuer-console-session", user: { userId: "issuer-admin", roleId: "key-manager", scopes: ["console:read"] } },
    }),
    verifyProcessIdentity: (evidence: unknown) => evidence,
  };
}

function operationPermissionResponseBody(response: Record<string, any>): any {
  return response.json();
}

describe("platform MCP key selection closure", () => {
  it.each([
    { label: "exact selection", allowedTools: ["meshrix.gateway.metrics"], deniedTools: [], expected: ["meshrix.gateway.metrics"] },
    { label: "explicit deny before allow", allowedTools: ["meshrix.gateway.metrics"], deniedTools: ["meshrix.gateway.metrics"], expected: [] },
    { label: "broad configured toolset", allowedTools: [], deniedTools: [], expected: ["meshrix.gateway.metrics", "meshrix.gateway.audit"] },
    { label: "explicit deny within a broad toolset", allowedTools: [], deniedTools: ["meshrix.gateway.metrics"], expected: ["meshrix.gateway.audit"] },
  ])("preserves static API-key $label", ({ allowedTools, deniedTools, expected }) => {
    const tools = ["meshrix.gateway.metrics", "meshrix.gateway.audit"].map((id) => ({
      id, status: "active", risk: "read_only", requiredScopes: ["gateway:read"], toolsets: ["gateway-read"],
    }));
    const provider = createToolSkillManagementProvider({ operationPermissionPlatform: { catalog: () => ({ tools }) } });
    const authorization = {
      credentialKind: "scoped_api_key",
      apiKeyAuthorization: { policy: {
        protocol: "mcp", allowedTools, deniedTools, scopeIds: ["gateway:read"], toolsetIds: ["gateway-read"],
        maximumRisk: "low", resources: { mode: "unrestricted" },
      } },
    };
    expect(provider.listVisibleTools({ authorization }).map((tool: { id: string }) => tool.id)).toEqual(expected);
  });

  it("issues exact discovered capabilities and enforces them through the production MCP gateway", async () => {
    let readTools = ["read_selected", "read_sibling"];
    const effects: Array<{ service: string; tool: string }> = [];
    const dispatchedOperations: string[] = [];
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const service = String(request.headers["x-fixture-service"] || "");
      const method = String(message.method || "");
      const result = method === "server/discover"
        ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : method === "tools/list"
          ? { resultType: "complete", tools: (service === "reader" ? readTools : ["write_selected", "write_sibling"])
            .map((name) => ({ name, inputSchema: { type: "object" } })) }
          : method === "tools/call"
            ? (() => {
                const name = String(message.params?.name || "");
                effects.push({ service, tool: name });
                return { resultType: "complete", content: [{ type: "text", text: `${service}:${name}` }], structuredContent: { service, tool: name } };
              })()
            : null;
      if (!result) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => peer.close((error) => error ? reject(error) : resolve())));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("Controlled MCP peer did not bind.");

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-key-selection-"));
    cleanup.push(() => fs.rm(tempRoot, { recursive: true, force: true }));
    const registry = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort() });
    cleanup.push(() => registry.close());
    const portableWriteDescriptor = {
      serviceProtocol: "mcp",
      label: "Inventory write",
      allowLocalNetwork: true,
      mcp: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "2026-07-28", headers: { "X-Fixture-Service": "writer" } },
    };
    installUpstreamRuntimeServices(registry, [
      {
        serviceId: "inventory-read",
        serviceProtocol: "mcp",
        label: "Inventory read",
        allowLocalNetwork: true,
        // Keep the internal read-only projection as a separate lower-risk path; the writer below uses the portable MCP default.
        operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
        mcp: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "2026-07-28", headers: { "X-Fixture-Service": "reader" } },
      },
      {
        serviceId: "inventory-write",
        ...portableWriteDescriptor,
      },
    ]);
    const projection = compileUpstreamOperationProjection(registry.captureManifestSnapshotState());
    const proof = createOperationProofSubstrate({ dataDir: path.join(tempRoot, "proof") });
    cleanup.push(() => proof.close());
    const securityPermissions = issuerSecurityPermissions();
    let operationPermission: Record<string, any> | null = null;
    let toolProvider: Record<string, any> | null = null;
    const controllerHandlers = createSystemControllerFoundationHandlers({
      accessControlContext: (authSession: unknown, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
      authorizationFacadeContext: (authSession: unknown, extra: Record<string, any> = {}) => ({ authSession, ...extra }),
      agentWorkspace: {},
      getToolSkillManagementProvider: () => toolProvider,
      getStrategyManagementProvider: () => null,
      protocolPayload: (body: unknown) => JSON.parse(Buffer.from(body as any || Buffer.alloc(0)).toString("utf8") || "{}"),
      runtime: {},
      workspaceIdFrom: () => "",
      sendConsoleDomainOperation: async ({ operationId, input, context, response }: Record<string, any>) => {
        const result = await executeConsoleDomainOperation({
          operationId,
          input,
          context: { ...context, upstreamGatewayRegistry: registry, operationProofSubstrate: proof },
        });
        response.writeHead(result.status || 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.payload));
      },
    });
    const staticOperationIds = ["gateway.metrics", "external_services.create", "gateway.forward", "gateway.payload.transit"];
    const staticOperations = OPERATION_REGISTRY_GOVERNED_DEFINITIONS.filter((operation: { id: string }) => staticOperationIds.includes(operation.id));
    expect(staticOperations).toHaveLength(staticOperationIds.length);
    const unselectedStaticTools = [
      "meshrix.gateway.metrics", "meshrix.gateway.externalServices.create", "meshrix.gateway.forward", "meshrix.gateway.payloadTransit",
    ];
    operationPermission = await createOperationPermissionPlatform({
      userDataPath: path.join(tempRoot, "operation-permission"),
      operations: [...projection.operations, ...staticOperations],
      operationDispatcher: (input: Record<string, any>) => {
        dispatchedOperations.push(String(input.operationId || ""));
        return dispatchOperation(input);
      },
      controllers: { system: controllerHandlers },
      securityPermissions,
      proofSubstrate: proof,
      apiKeyVerifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 73)),
      readMcpToolSelection: ({ authorization, signal }: Record<string, any>) => readAuthorizedMcpToolSelection({
        registry,
        operationRegistry: operationPermission?.registry,
        authorization,
        signal,
      }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanup.push(() => operationPermission!.close());
    expect(operationPermission.registry.getCatalog().tools.map((tool: { id: string }) => tool.id))
      .toEqual(expect.arrayContaining(unselectedStaticTools));

    toolProvider = createToolSkillManagementProvider({
      operationPermissionPlatform: operationPermission,
      securityPermissions,
      evaluateToolAudience: ({ authorization, grant, restriction, subject, tool, purpose }: Record<string, any>) => {
        if (tool?._meta?.upstreamMcp === true) {
          return registry.evaluateDiscoveredMcpToolAudience({ grant, restriction, subject, tool, purpose });
        }
        return registry.evaluateProjectedOperationAudience({
          grant,
          restriction,
          subject,
          tool: { ...tool, upstreamProjectedOperation: true },
          purpose,
        });
      },
    });
    const platform = createPlatformMcpGateway({
      upstreamGatewayRegistry: registry,
      toolSkillManagementProvider: toolProvider,
      operationProofSubstrate: proof,
      runtimeLogger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    cleanup.push(() => platform.close());
    await platform.gateway.start();

    const apiClient = {
      async getIssuerScopes() {
        const response = capturedResponse();
        await operationPermission!.router.handleOperationPermissionHttpRequest({
          request: { method: "GET", headers: { host: "meshrix.test" } },
          response,
          requestBody: Buffer.alloc(0),
          url: new URL("http://meshrix.test/api/operation-permission/v1/api-keys/issuer-scopes"),
          method: "GET",
          signal: new AbortController().signal,
        });
        if (response.statusCode !== 200) throw new Error("Authorized issuer scope read failed.");
        return operationPermissionResponseBody(response);
      },
      async list() { return { records: [], nextCursor: null }; },
      async getCatalog() { return operationPermission!.registry.getCatalog(); },
      async create(input: Record<string, any>) {
        return operationPermission!.apiKeyDistributionProvider.create({ ...input, subjectId: "issuer-admin" });
      },
    };
    const consoleController = useConsoleApiKeyDistributionController({
      client: apiClient as any,
      confirmAction: async () => true,
    });
    expect(await consoleController.refresh()).toBe(true);
    const selectedRead = consoleController.mcpToolOptions.value.find((tool) =>
      tool.serviceId === "inventory-read" && tool.publicName.endsWith(".read_selected"));
    const siblingRead = consoleController.mcpToolOptions.value.find((tool) =>
      tool.serviceId === "inventory-read" && tool.publicName.endsWith(".read_sibling"));
    const selectedWrite = consoleController.mcpToolOptions.value.find((tool) =>
      tool.serviceId === "inventory-write" && tool.publicName.endsWith(".write_selected"));
    const siblingWrite = consoleController.mcpToolOptions.value.find((tool) =>
      tool.serviceId === "inventory-write" && tool.publicName.endsWith(".write_sibling"));
    expect(selectedRead && siblingRead && selectedWrite && siblingWrite).toBeTruthy();
    expect(selectedRead).toMatchObject({ risk: "read_only", requiredScopes: ["gateway:read"] });
    expect(selectedWrite).toMatchObject({ risk: "safe_write", requiredScopes: ["gateway:write"] });

    Object.assign(consoleController.draft.value, {
      workloadDisplayName: "Inventory reader",
      organizationNodeId: "issuer",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
      selectedTargetIds: [],
    });
    consoleController.toggleMcpToolSelection(selectedRead!);
    expect(consoleController.draftValid.value).toBe(true);
    await consoleController.create();
    const readKey = consoleController.oneTimeSecret.value;
    expect(readKey).toMatch(/^mxak1\./u);
    expect(consoleController.records.value[0].policy.capabilityIds).toContain(selectedRead!.capabilityId);
    expect(consoleController.records.value[0].policy.capabilityIds).not.toContain(siblingRead!.capabilityId);

    const call = (credential: string, method: string, params: Record<string, unknown> = {}) => {
      const wireRequest = modernHttpRequest(method, `${method}-${effects.length}-${Date.now()}`, params, {}, {
        host: "meshrix.test",
        "X-Meshrix.js-Api-Key": credential,
      });
      // Match the production HTTP route assembly: Node lowercases request headers,
      // and the platform authorizer reads the raw request alongside parsed fields.
      const headers = Object.fromEntries(Object.entries(wireRequest.headers).map(([name, value]) => [name.toLowerCase(), value]));
      return platform.adapter.handle({
        ...wireRequest,
        headers,
        rawRequest: { method: "POST", headers, url: "/mcp" },
        requestBody: Buffer.from(JSON.stringify(wireRequest.body), "utf8"),
        url: new URL("http://meshrix.test/mcp"),
      });
    };
    const expectExactCatalog = async (credential: string, names: string[], selectedNames: string[]) => {
      expect(names).toEqual(expect.arrayContaining(["meshrix.discovery", "meshrix.gateway", ...selectedNames]));
      for (const name of unselectedStaticTools) expect(names).not.toContain(name);
      const capabilities = await call(credential, "tools/call", {
        name: "meshrix.discovery", arguments: { operation: "meshrix.capabilities.list" },
      });
      expect(capabilities.status).toBe(200);
      const capabilityNames = (capabilities.body as any).result.structuredContent.operations.map((operation: { name: string }) => operation.name);
      expect(capabilityNames).toEqual(expect.arrayContaining(selectedNames));
      for (const name of unselectedStaticTools) expect(capabilityNames).not.toContain(name);
      const dispatchedBefore = [...dispatchedOperations];
      const effectsBefore = [...effects];
      for (const operation of unselectedStaticTools) {
        const denied = await call(credential, "tools/call", { name: "meshrix.gateway", arguments: { operation, input: {} } });
        expect(denied.body).toMatchObject({ error: { data: { code: "operation_not_published", effectOutcome: "not_started" } } });
      }
      expect(dispatchedOperations).toEqual(dispatchedBefore);
      expect(effects).toEqual(effectsBefore);
    };
    const readListing = await call(readKey, "tools/list");
    const readListingErrorCode = String(
      (readListing.body as any)?.error?.data?.code
        || (readListing.body as any)?.result?.error?.data?.code
        || (readListing.body as any)?.error?.code
        || (readListing.body as any)?.result?.error?.code
        || "unknown",
    );
    expect(readListing.status, `MCP tools/list failed with ${readListingErrorCode}`).toBe(200);
    expect(readListing.body, `MCP tools/list failed with ${readListingErrorCode}`)
      .toMatchObject({ result: { tools: expect.any(Array) } });
    const readNames = (readListing.body as any).result.tools.map((tool: Record<string, any>) => tool.name);
    expect(readNames).toContain(selectedRead!.publicName);
    expect(readNames).not.toContain(siblingRead!.publicName);
    expect(readNames).not.toContain(selectedWrite!.publicName);
    await expectExactCatalog(readKey, readNames, [selectedRead!.publicName]);
    const readResult = await call(readKey, "tools/call", { name: selectedRead!.publicName, arguments: {} });
    expect(readResult.body).toMatchObject({ result: { resultType: "complete" } });
    expect(effects).toEqual([{ service: "reader", tool: "read_selected" }]);
    const underAuthorizedWrite = await call(readKey, "tools/call", { name: selectedWrite!.publicName, arguments: {} });
    expect(underAuthorizedWrite.body.result?.isError === true || Boolean(underAuthorizedWrite.body.error)).toBe(true);
    expect(effects).toEqual([{ service: "reader", tool: "read_selected" }]);

    consoleController.dismissSecret();
    consoleController.toggleMcpToolSelection(selectedWrite!);
    await consoleController.create();
    const writeKey = consoleController.oneTimeSecret.value;
    expect(writeKey).toMatch(/^mxak1\./u);
    const issuedPolicy = consoleController.records.value[0].policy;
    expect(issuedPolicy.maximumRisk).toBe("medium");
    expect(issuedPolicy.scopeIds).toContain("gateway:write");
    expect(issuedPolicy.capabilityIds).toContain(selectedRead!.capabilityId);
    expect(issuedPolicy.capabilityIds).toContain(selectedWrite!.capabilityId);
    expect(issuedPolicy.capabilityIds).not.toContain(siblingWrite!.capabilityId);

    const writeListing = await call(writeKey, "tools/list");
    const writeNames = (writeListing.body as any).result.tools.map((tool: Record<string, any>) => tool.name);
    expect(writeNames).toContain(selectedRead!.publicName);
    expect(writeNames).toContain(selectedWrite!.publicName);
    expect(writeNames).not.toContain(siblingRead!.publicName);
    expect(writeNames).not.toContain(siblingWrite!.publicName);
    await expectExactCatalog(writeKey, writeNames, [selectedRead!.publicName, selectedWrite!.publicName]);
    const writeResult = await call(writeKey, "tools/call", { name: selectedWrite!.publicName, arguments: {} });
    expect(writeResult.body).toMatchObject({ result: { resultType: "complete" } });
    expect(effects.filter((effect) => effect.service === "writer")).toEqual([{ service: "writer", tool: "write_selected" }]);

    readTools = [...readTools, "read_added_after_issue"];
    await registry.listMcpTools({ serviceId: "inventory-read", refresh: true });
    const refreshedListing = await call(writeKey, "tools/list");
    const refreshedNames = (refreshedListing.body as any).result.tools.map((tool: Record<string, any>) => tool.name);
    expect(refreshedNames).not.toContain("upstream.inventory-read.read_added_after_issue");
    const deniedSibling = await call(writeKey, "tools/call", { name: siblingWrite!.publicName, arguments: {} });
    const deniedNew = await call(writeKey, "tools/call", { name: "upstream.inventory-read.read_added_after_issue", arguments: {} });
    expect(deniedSibling.body.result?.isError === true || Boolean(deniedSibling.body.error)).toBe(true);
    expect(deniedNew.body.result?.isError === true || Boolean(deniedNew.body.error)).toBe(true);
    expect(effects).toEqual([
      { service: "reader", tool: "read_selected" },
      { service: "writer", tool: "write_selected" },
    ]);

    const protectedReceipts = await proof.listReceipts({ limit: 200 });
    expect(protectedReceipts.some((receipt: Record<string, any>) =>
      String(receipt.operationId || "").includes("upstream.mcp.inventory-write") && receipt.status === "succeeded",
    )).toBe(true);
  }, 20_000);
});
