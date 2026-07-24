import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upstreamOperationCapabilityId } from "../../../packages/agents/src/upstream-gateway/operation-capability.mjs";

import {
  bindVerifierLocalMcpGrantIdentity,
  createVerifierLocalMcpGrantIdentity,
  verifierMcpRequestHeaders
} from "./local-mcp-verifier-identity.mjs";
import {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E,
  TAG_GOVERNED_ENTITY_REFS
} from "./operation-permission-tag-governed-e2e-constants.mjs";
import { issueVerifierLocalMcpGrant } from "./local-mcp-device-authorization.mjs";
import {
  closeServer,
  createTagGovernedFixtureState,
  startTagGovernedFixtureServer,
  seedTagGovernedUpstreamService
} from "./operation-permission-tag-governed-e2e-fixture.mjs";
import {
  createOperationPermissionTagGovernedE2eReportHarness
} from "./operation-permission-tag-governed-e2e-report.mjs";

export {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E,
  TAG_GOVERNED_ENTITY_REFS
} from "./operation-permission-tag-governed-e2e-constants.mjs";

function parseSseBlock(block = "") {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (!dataLines.length) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
}

export async function createOperationPermissionTagGovernedE2eHarness() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-permission-tag-e2e-"));
  const fixtureState = createTagGovernedFixtureState();
  const createdGrantIds = [];
  const mcpIdentityByToken = new Map();

  let server = null;
  let fixture = null;
  let fixtureUrl = "";
  let mcpToken = "";
  let mcpGrantId = "";
  let operationOutletByName = new Map();
  const reportHarness = createOperationPermissionTagGovernedE2eReportHarness({
    userDataPath,
    getFixtureUrl: () => fixtureUrl
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

  async function startFixture() {
    const started = await startTagGovernedFixtureServer(fixtureState);
    fixture = started.server;
    fixtureUrl = started.url;
    trackSecret(fixtureUrl, new URL(fixtureUrl).host);
    return started;
  }

  async function writeUpstreamGatewayConfig() {
    await seedTagGovernedUpstreamService({ userDataPath, fixtureUrl });
  }

  async function fetchJson(routeOrUrl, options = {}) {
    const { expectedStatuses = null, allowSecretPayload = false, ...fetchOptions } = options;
    const url = String(routeOrUrl).startsWith("http")
      ? routeOrUrl
      : `${server.url}${routeOrUrl}`;
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    const publicPayload = allowSecretPayload ? null : safeEvidence(payload);
    if (!allowSecretPayload) {
      assertNoLeak(publicPayload, String(routeOrUrl));
    }
    if (expectedStatuses) {
      const diagnostic = publicPayload === null ? "" : `: ${JSON.stringify(publicPayload)}`;
      assert.equal(
        expectedStatuses.includes(response.status),
        true,
        `Unexpected status ${response.status} for ${routeOrUrl}${diagnostic}`
      );
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async function api(method, route, body = undefined, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    return fetchJson(route, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...requestOptions
    });
  }

  function mcpHeaders(token = mcpToken, {
    method = "POST",
    body = "",
    url = `${server.url}/mcp`,
    extraHeaders = {}
  } = {}) {
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

  async function createLocalGrant(input = {}) {
    const verifierIdentity = createVerifierLocalMcpGrantIdentity({
      target: "codex",
      label: "verify-operation-permission-tag-governed-e2e"
    });
    const response = await issueVerifierLocalMcpGrant({
      server,
      grantRequest: {
        targets: ["codex"],
        label: "Operation Permission tag-governed E2E verifier",
        connectorVersion: "verify-operation-permission-tag-governed-e2e",
        agentProfileId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.agentProfileId,
        grantMode: "maintain",
        maxRisk: "repair_write",
        dynamicCapabilities: [upstreamOperationCapabilityId(
          { serviceId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId },
          { operationKey: "echo" }
        )],
        allowedServiceIds: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId],
        toolsets: [
          "meshrix.gateway.admin",
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
        ],
        processIdentity: verifierIdentity.request,
        ...input
      }
    });
    const token = String(response.payload.token || "");
    const grantId = String(response.payload.grantId || response.payload.grant?.id || "");
    assert.ok(token, "local grant did not return a token");
    assert.ok(grantId, "local grant did not return a grant id");
    trackSecret(token, grantId, response.payload.grant?.tokenPrefix, response.payload.tokenPrefix);
    bindVerifierLocalMcpGrantIdentity({
      identityByToken: mcpIdentityByToken,
      token,
      identity: verifierIdentity.identity,
      payload: response.payload
    });
    createdGrantIds.push(grantId);
    return { token, grantId, grant: response.payload.grant || {} };
  }

  function mcpPayload(jsonRpcPayload = {}) {
    return jsonRpcPayload?.result?.structuredContent?.payload ||
      jsonRpcPayload?.result?.structuredContent ||
      jsonRpcPayload?.result ||
      {};
  }

  function operationNames(capabilities = {}) {
    return new Set((capabilities.operations || []).map((operation) => String(operation.name || "")));
  }

  async function openMcpSse(token) {
    const controller = new AbortController();
    const events = [];
    let buffer = "";
    const url = `${server.url}/mcp?capability=upstream.catalog.list_changed`;
    const stream = fetch(url, {
      method: "GET",
      headers: mcpHeaders(token, {
        method: "GET",
        body: "",
        url,
        extraHeaders: {
          "X-Meshrix-Mcp-Proxy-Session": "taggovernede2esession"
        }
      }),
      signal: controller.signal
    }).then(async (response) => {
      assert.equal(response.status, 200, "MCP SSE stream did not open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            events.push(parsed);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    }).catch((error) => {
      if (error?.name !== "AbortError") {
        throw error;
      }
    });

    async function waitForReasonCode(reasonCode, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find((event) =>
          event?.method === "notifications/tools/list_changed" &&
            String(event?.params?.change?.reasonCode || "") === reasonCode
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for MCP list_changed reason ${reasonCode}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      events,
      waitForReasonCode,
      close: async () => {
        controller.abort();
        await stream;
      }
    };
  }

  async function callMcpWithToolName(token, toolName, operation, input = {}, id = 1, expectedStatuses = [200]) {
    const body = JSON.stringify({
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
    const response = await fetchJson("/mcp", {
      method: "POST",
      headers: mcpHeaders(token, { body }),
      body,
      expectedStatuses
    });
    return response.payload;
  }

  async function callMcp(operation, input = {}, id = 1, expectedStatuses = [200]) {
    const toolName = operationOutletByName.get(operation) || "meshrix.discovery";
    return callMcpWithToolName(mcpToken, toolName, operation, input, id, expectedStatuses);
  }

  async function capabilitiesForToken(token, id = 1) {
    const payload = await callMcpWithToolName(token, "meshrix.discovery", "meshrix.capabilities.list", {}, id);
    assertMcpOk(payload, "capabilities");
    return mcpPayload(payload);
  }

  function assertMcpOk(payload, label) {
    assert.equal(payload.error, undefined, `${label} returned MCP error: ${JSON.stringify(safeEvidence(payload.error || {}))}`);
  }

  function assertMcpDenied(payload, label) {
    assert.ok(payload.error, `${label} unexpectedly succeeded`);
    const text = JSON.stringify(payload.error || {}).toLowerCase();
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

  function denialSummary(payload = {}) {
    const text = JSON.stringify(payload.error || {});
    const reasonCode =
      payload.error?.code ||
      payload.error?.data?.payload?.error?.code ||
      payload.error?.data?.error?.code ||
      (text.includes("tag_policy_denied") ? "tag_policy_denied" : "denied");
    return {
      reasonCode: String(reasonCode || "denied"),
      matchedDenyTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.denyTag]
    };
  }

  function tagPolicy(entityRef) {
    return {
      entityRefs: [{ entityType: entityRef.entityType, entityId: entityRef.entityId }],
      allowTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.allowTag],
      denyTags: [OPERATION_PERMISSION_TAG_GOVERNED_E2E.denyTag]
    };
  }

  function tagProjections() {
    return Object.values(TAG_GOVERNED_ENTITY_REFS).map((entity) => ({
      entityType: entity.entityType,
      entityId: entity.entityId,
      payload: {
        capability: entity.capability
      }
    }));
  }

  async function upsertTag(tagId, label, projections = []) {
    const response = await api("POST", "/api/tag-management/v1/tags", {
      tagId,
      kind: "custom",
      label,
      scopePrerequisites: ["auth:admin"],
      metadata: projections.length ? { projections } : {}
    }, { expectedStatuses: [200, 201] });
    return response.payload.tag;
  }

  async function rebuildTagProjections() {
    const response = await api("POST", "/api/tag-management/v1/projections/rebuild", {}, { expectedStatuses: [200] });
    return response.payload.rebuild || {};
  }

  async function registerGatewayFixture() {
    const response = await api("GET", "/api/gateway/v1/external-services", undefined, { expectedStatuses: [200] });
    const service = (response.payload.items || []).find((item) =>
      item.serviceId === OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId
    );
    assert.ok(service, "configured gateway service missing");
    const rejected = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "tag-governed-remote-registration-forbidden",
      baseUrl: fixtureUrl
    }, { expectedStatuses: [400, 403, 404, 405] });
    assert.equal(rejected.status >= 400, true);
    return {
      serviceId: OPERATION_PERMISSION_TAG_GOVERNED_E2E.serviceId,
      loadedFromPublishedManifest: true
    };
  }

  async function refreshCapabilities() {
    const payload = await callMcp("meshrix.capabilities.list", {}, 10);
    assertMcpOk(payload, "capabilities");
    const capabilities = mcpPayload(payload);
    operationOutletByName = new Map((capabilities.operations || []).map((operation) => [
      String(operation.name || ""),
      String(operation?._meta?.mcpOutlet || "meshrix.discovery")
    ]));
    const missing = OPERATION_PERMISSION_TAG_GOVERNED_E2E.requiredPublicOperations
      .filter((operation) => !operationOutletByName.has(operation));
    assert.deepEqual(
      missing,
      [],
      `Missing required MCP operations: ${missing.join(", ")}`
    );
    return { operationCount: capabilities.operations?.length || 0 };
  }

  async function cleanup({ restoreCapabilityKernelEnv = null } = {}) {
    if (server?.close) {
      await server.close();
    }
    await closeServer(fixture);
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
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
    setServer(target) {
      server = target;
      if (server?.url) {
        trackSecret(server.url, new URL(server.url).host);
      }
    },
    setPrimaryGrant(grant = {}) {
      mcpToken = String(grant.token || "");
      mcpGrantId = String(grant.grantId || "");
    },
    getMcpGrantId() {
      return mcpGrantId;
    },
    getMcpToken() {
      return mcpToken;
    },
    api,
    assertMcpDenied,
    assertMcpOk,
    callMcp,
    callMcpWithToolName,
    capabilitiesForToken,
    createLocalGrant,
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
