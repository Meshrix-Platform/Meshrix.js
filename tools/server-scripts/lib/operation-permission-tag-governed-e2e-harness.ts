import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upstreamOperationCapabilityId } from "../../../packages/agents/src/upstream-gateway/operation-capability.ts";

import {
  bindVerifierApiKey,
  createVerifierApiKeyAccess,
  verifierMcpRequestHeaders
} from "./verifier-mcp-api-key.ts";
import {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E,
  TAG_GOVERNED_ENTITY_REFS
} from "./operation-permission-tag-governed-e2e-constants.ts";
import { issueVerifierMcpApiKey } from "./verifier-mcp-api-key.ts";
import {
  closeServer,
  createTagGovernedFixtureState,
  startTagGovernedFixtureServer,
  seedTagGovernedUpstreamService
} from "./operation-permission-tag-governed-e2e-fixture.ts";
import {
  createOperationPermissionTagGovernedE2eReportHarness
} from "./operation-permission-tag-governed-e2e-report.ts";

export {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E,
  TAG_GOVERNED_ENTITY_REFS
} from "./operation-permission-tag-governed-e2e-constants.ts";

function parseSseBlock(block: any = "") : any {
  const dataLines: any = block
    .split(/\r?\n/)
    .filter((line?: any) : any => line.startsWith("data:"))
    .map((line?: any) : any => line.slice("data:".length).trim());
  if (!dataLines.length) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}

export async function createOperationPermissionTagGovernedE2eHarness() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-permission-tag-e2e-"));
  const fixtureState: any = createTagGovernedFixtureState();
  const createdGrantIds: any[] = [];
  const mcpIdentityByToken: any = new Map<any, any>();

  let server: any = null;
  let fixture: any = null;
  let fixtureUrl: any = "";
  let mcpToken: any = "";
  let mcpGrantId: any = "";
  let operationOutletByName: any = new Map<any, any>();
  const reportHarness: any = createOperationPermissionTagGovernedE2eReportHarness({
    userDataPath,
    getFixtureUrl: () : any => fixtureUrl
  });
  const {
    trackSecret,
    redactText,
    safeEvidence,
    assertNoLeak,
    writeReport,
    test,
    destructiveTest
  } = reportHarness;

  async function startFixture() : Promise<any> {
    const started: any = await startTagGovernedFixtureServer(fixtureState);
    fixture = started.server;
    fixtureUrl = started.url;
    trackSecret(fixtureUrl, new URL(fixtureUrl).host);
    return started;
  }

  async function writeUpstreamGatewayConfig() : Promise<any> {
    await seedTagGovernedUpstreamService({ userDataPath, fixtureUrl });
  }

  async function fetchJson(routeOrUrl?: any, options: Record<string, any> = {}) : Promise<any> {
    const { expectedStatuses = null, allowSecretPayload = false, ...fetchOptions } = options;
    const url: any = String(routeOrUrl).startsWith("http")
      ? routeOrUrl
      : `${server.url}${routeOrUrl}`;
    const response: any = await fetch(url, fetchOptions);
    const text: any = await response.text();
    const payload: any = text.trim() ? JSON.parse(text) : {};
    const publicPayload: any = allowSecretPayload ? null : safeEvidence(payload);
    if (!allowSecretPayload) {
      assertNoLeak(publicPayload, String(routeOrUrl));
    }
    if (expectedStatuses) {
      const diagnostic: any = publicPayload === null ? "" : `: ${JSON.stringify(publicPayload)}`;
      assert.equal(
        expectedStatuses.includes(response.status),
        true,
        `Unexpected status ${response.status} for ${routeOrUrl}${diagnostic}`
      );
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async function api(method?: any, route?: any, body: any = undefined, options: Record<string, any> = {}) : Promise<any> {
    const { headers = {}, ...requestOptions } = options;
    return fetchJson(route, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...requestOptions
    });
  }

  function mcpHeaders(token: any = mcpToken, {
    method = "POST",
    body = "",
    url = `${server.url}/mcp`,
    extraHeaders = {}
  }: Record<string, any> = {}) : any {
    return verifierMcpRequestHeaders({
      identityByToken: mcpIdentityByToken,
      token,
      target: "codex",
      method,
      url,
      body,
      extraHeaders
    });
  }

  async function createVerifierApiKey(input: Record<string, any> = {}) : Promise<any> {
    const verifierAccess: any = createVerifierApiKeyAccess({
      target: "codex",
      label: "verify-operation-permission-tag-governed-e2e"
    });
    const requestedToolsets: any = [
      "meshrix.gateway.write",
      "meshrix.gateway.read",
      "meshrix.agent.workspace.read",
      "meshrix.agent.workspace",
      "meshrix.agent.workspace.maintain",
      "meshrix.storage.read",
      "meshrix.storage.write",
      "meshrix.runtime.maintain",
      "meshrix.authorization.admin",
      "meshrix.console.read"
    ];
    const response: any = await issueVerifierMcpApiKey({
      server,
      access: {
        targets: ["codex"],
        connectorVersion: "verify-operation-permission-tag-governed-e2e",
        agentProfileId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.agentProfileId,
        grantMode: "maintain",
        maxRisk: "repair_write",
        dynamicCapabilities: [upstreamOperationCapabilityId(
          { serviceId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId },
          { operationKey: "echo" }
        )],
        allowedServiceIds: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId],
        toolsets: requestedToolsets,
        label: verifierAccess.label,
        ...input
      }
    });
    const token: any = response.apiKey;
    const keyId: any = response.record.keyId;
    assert.ok(token, "API Key issuance did not return plaintext to the direct verifier caller");
    assert.ok(keyId, "API Key issuance did not return a bounded record identifier");
    trackSecret(token, keyId);
    bindVerifierApiKey({
      identityByToken: mcpIdentityByToken,
      token,
      record: response.record
    });
    createdGrantIds.push(keyId);
    return { token, keyId, record: response.record, toolsets: requestedToolsets };
  }

  function mcpPayload(jsonRpcPayload: Record<string, any> = {}) : any {
    return jsonRpcPayload?.result?.structuredContent?.payload ||
      jsonRpcPayload?.result?.structuredContent ||
      jsonRpcPayload?.result ||
      {};
  }

  function operationNames(capabilities: Record<string, any> = {}) : any {
    return new Set<any>((capabilities.operations || []).map((operation?: any) : any => String(operation.name || "")));
  }

  async function openMcpSse(token?: any) : Promise<any> {
    const controller: any = new AbortController();
    const events: any[] = [];
    let buffer: any = "";
    const url: any = `${server.url}/mcp?capability=upstream.catalog.list_changed`;
    const stream: any = fetch(url, {
      method: "GET",
      headers: mcpHeaders(token, {
        method: "GET",
        body: "",
        url,
        extraHeaders: {
          "X-Meshrix.js-Mcp-Proxy-Session": "taggovernede2esession"
        }
      }),
      signal: controller.signal
    }).then(async (response?: any) : Promise<any> => {
      assert.equal(response.status, 200, "MCP SSE stream did not open");
      const reader: any = response.body.getReader();
      const decoder: any = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary: any = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block: any = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed: any = parseSseBlock(block);
          if (parsed) {
            events.push(parsed);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    }).catch((error?: any) : any => {
      if (error?.name !== "AbortError") {
        throw error;
      }
    });

    async function waitForReasonCode(reasonCode?: any, timeoutMs: any = 5000) : Promise<any> {
      const deadline: any = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found: any = events.find((event?: any) : any =>
          event?.method === "notifications/tools/list_changed" &&
            String(event?.params?.change?.reasonCode || "") === reasonCode
        );
        if (found) {
          return found;
        }
        await new Promise((resolve?: any) : any => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for MCP list_changed reason ${reasonCode}`);
    }

    await new Promise((resolve?: any) : any => setTimeout(resolve, 150));
    return {
      events,
      waitForReasonCode,
      close: async () : Promise<any> => {
        controller.abort();
        await stream;
      }
    };
  }

  async function callMcpWithToolName(token?: any, toolName?: any, operation?: any, input: Record<string, any> = {}, id: any = 1, expectedStatuses: any = [200]) : Promise<any> {
    const body: any = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: {
          apiVersion: OPERATION_PERMISSION_TAG_GOVERNED_E2E.mcpInterfaceVersion,
          operation,
          input,
          clientVersion: "verify-operation-permission-tag-governed-e2e"
        }
      }
    });
    const response: any = await fetchJson("/mcp", {
      method: "POST",
      headers: mcpHeaders(token, { body }),
      body,
      expectedStatuses
    });
    return response.payload;
  }

  async function callMcp(operation?: any, input: Record<string, any> = {}, id: any = 1, expectedStatuses: any = [200]) : Promise<any> {
    const toolName: any = operationOutletByName.get(operation) || "meshrix.discovery";
    return callMcpWithToolName(mcpToken, toolName, operation, input, id, expectedStatuses);
  }

  async function capabilitiesForToken(token?: any, id: any = 1) : Promise<any> {
    const payload: any = await callMcpWithToolName(token, "meshrix.discovery", "meshrix.capabilities.list", {}, id);
    assertMcpOk(payload, "capabilities");
    return mcpPayload(payload);
  }

  function assertMcpOk(payload?: any, label?: any) : any {
    assert.equal(payload.error, undefined, `${label} returned MCP error: ${JSON.stringify(safeEvidence(payload.error || {}))}`);
  }

  function assertMcpDenied(payload?: any, label?: any) : any {
    assert.ok(payload.error, `${label} unexpectedly succeeded`);
    const text: any = JSON.stringify(payload.error || {}).toLowerCase();
    assert.equal(
      text.includes("tag_policy_denied") ||
        text.includes("policy_denied") ||
        text.includes("denied") ||
        text.includes("unknown") ||
        text.includes("not_found") ||
        text.includes("not found") ||
        text.includes("outlet") ||
        text.includes("missing") ||
        text.includes("permission") ||
        text.includes("forbidden") ||
        text.includes("权限不足"),
      true,
      `${label} did not expose a denial reason`
    );
  }

  function denialSummary(payload: Record<string, any> = {}) : any {
    const text: any = JSON.stringify(payload.error || {});
    const reasonCode: any =
      payload.error?.code ||
      payload.error?.data?.payload?.error?.code ||
      payload.error?.data?.error?.code ||
      (text.includes("tag_policy_denied") ? "tag_policy_denied" : "denied");
    return {
      reasonCode: String(reasonCode || "denied"),
      matchedDenyTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.denyTag]
    };
  }

  function tagPolicy(entityRef?: any) : any {
    return {
      entityRefs: [{ entityType: entityRef.entityType, entityId: entityRef.entityId }],
      allowTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.allowTag],
      denyTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.denyTag]
    };
  }

  function tagProjections() : any {
    return (Object.values(TAG_GOVERNED_ENTITY_REFS) as any[]).map((entity?: any) : any => ({
      entityType: entity.entityType,
      entityId: entity.entityId,
      payload: {
        capability: entity.capability
      }
    }));
  }

  async function upsertTag(tagId?: any, label?: any, projections: any = []) : Promise<any> {
    const response: any = await api("POST", "/api/tag-management/v1/tags", {
      tagId,
      kind: "custom",
      label,
      scopePrerequisites: ["auth:admin"],
      metadata: projections.length ? { projections } : {}
    }, { expectedStatuses: [200, 201] });
    return response.payload.tag;
  }

  async function rebuildTagProjections() : Promise<any> {
    const response: any = await api("POST", "/api/tag-management/v1/projections/rebuild", {}, { expectedStatuses: [200] });
    return response.payload.rebuild || {};
  }

  async function registerGatewayFixture() : Promise<any> {
    const response: any = await api("GET", "/api/gateway/v1/external-services", undefined, { expectedStatuses: [200] });
    const service: any = (response.payload.items || []).find((item?: any) : any =>
      item.serviceId === OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId
    );
    assert.ok(service, "configured gateway service missing");
    const rejected: any = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "tag-governed-remote-registration-forbidden",
      baseUrl: fixtureUrl
    }, { expectedStatuses: [400, 403, 404, 405] });
    assert.equal(rejected.status >= 400, true);
    return {
      serviceId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId,
      loadedFromPublishedManifest: true
    };
  }

  async function refreshCapabilities() : Promise<any> {
    const payload: any = await callMcp("meshrix.capabilities.list", {}, 10);
    assertMcpOk(payload, "capabilities");
    const capabilities: any = mcpPayload(payload);
    operationOutletByName = new Map<any, any>((capabilities.operations || []).map((operation?: any) : any => [
      String(operation.name || ""),
      String(operation?._meta?.mcpOutlet || "meshrix.discovery")
    ]));
    const missing: any = OPERATION_PERMISSION_TAG_GOVERNED_E2E.requiredPublicOperations
      .filter((operation?: any) : any => !operationOutletByName.has(operation));
    assert.deepEqual(
      missing,
      [],
      `Missing required MCP operations: ${missing.join(", ")}`
    );
    return { operationCount: capabilities.operations?.length || 0 };
  }

  async function cleanup({ restoreCapabilityKernelEnv = null }: Record<string, any> = {}) : Promise<any> {
    if (server?.close) {
      await server.close();
    }
    await closeServer(fixture);
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
    if (typeof restoreCapabilityKernelEnv === "function") {
      restoreCapabilityKernelEnv();
    }
  }

  return {
    userDataPath,
    fixtureState,
    createdGrantIds,
    trackSecret,
    redactText,
    safeEvidence,
    writeReport,
    test,
    destructiveTest,
    startFixture,
    writeUpstreamGatewayConfig,
    setServer(target?: any) : any {
      server = target;
      if (server?.url) {
        trackSecret(server.url, new URL(server.url).host);
      }
    },
    setPrimaryGrant(grant: Record<string, any> = {}) : any {
      mcpToken = String(grant.token || "");
      mcpGrantId = String(grant.grantId || "");
    },
    getMcpGrantId() : any {
      return mcpGrantId;
    },
    getMcpToken() : any {
      return mcpToken;
    },
    api,
    assertMcpDenied,
    assertMcpOk,
    callMcp,
    callMcpWithToolName,
    capabilitiesForToken,
    createVerifierApiKey,
    denialSummary,
    mcpPayload,
    openMcpSse,
    operationNames,
    rebuildTagProjections,
    registerGatewayFixture,
    refreshCapabilities,
    tagPolicy,
    tagProjections,
    upsertTag,
    cleanup
  };
}
