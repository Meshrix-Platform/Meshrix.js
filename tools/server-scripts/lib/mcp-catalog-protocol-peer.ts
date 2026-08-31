import assert from "node:assert/strict";

import {
  MCP_CATALOG_ACKNOWLEDGE_METHOD,
  MCP_CATALOG_LIST_CHANGED_METHOD,
  MCP_PROXY_SESSION_HEADER,
  normalizeMcpProxySessionId,
  parseMcpCatalogFacts,
  parseMcpCatalogInvalidation
} from "../../../packages/contracts/src/mcp-catalog-delivery.ts";
import { issueVerifierMcpApiKey } from "./verifier-mcp-api-key.ts";
import {
  bindVerifierApiKey,
  createVerifierApiKeyAccess,
  verifierMcpRequestHeaders
} from "./verifier-mcp-api-key.ts";

function parseSsePayload(block?: any) : any {
  const data: any = String(block || "").split(/\r?\n/u)
    .filter((line?: any) : any => line.startsWith("data:"))
    .map((line?: any) : any => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function issueNeutralMcpProtocolGrant({
  server,
  approvalAuth,
  peerId = "primary",
  toolsets = [],
  dynamicCapabilities = [],
  allowedServiceIds = [],
  allowedSecretBindings = [],
  maxRisk = "read_only",
  maxUses = 4_096,
  requestsPerWindow = 4_096
}: Record<string, any> = {}) : Promise<any> {
  const normalizedPeerId: any = String(peerId || "primary").replace(/[^a-z0-9-]+/giu, "-").slice(0, 48);
  const target: any = "";
  const identityByToken: any = new Map<any, any>();
  const verifierAccess: any = createVerifierApiKeyAccess({
    target,
    label: `neutral-protocol-peer-${normalizedPeerId}`
  });
  const response: any = await issueVerifierMcpApiKey({
    server,
    consoleAuth: approvalAuth,
    access: {
      targets: [],
      connectorVersion: "protocol-peer",
      grantMode: "maintain",
      maxRisk,
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      maxUses,
      requestsPerWindow,
      label: verifierAccess.label
    }
  });
  const token: any = response.apiKey;
  const keyId: any = response.record.keyId;
  assert.ok(token && keyId, "Neutral protocol API Key issuance failed.");
  bindVerifierApiKey({
    identityByToken,
    token,
    record: response.record
  });
  return {
    token,
    keyId,
    workloadPrincipalId: String(response.record.workloadPrincipalId || ""),
    lifecycleRevision: Number(response.record.lifecycleRevision || 0),
    identityByToken,
    target
  };
}

export function createMcpCatalogProtocolPeer({
  baseUrl,
  grant,
  proxySessionId,
  fetchImpl = globalThis.fetch
}: Record<string, any> = {}) : any {
  const origin: any = String(baseUrl || "").replace(/\/+$/u, "");
  const sessionId: any = normalizeMcpProxySessionId(proxySessionId);
  if (!origin || !grant?.token || !grant?.identityByToken || !sessionId || typeof fetchImpl !== "function") {
    throw new TypeError("Neutral MCP protocol peer requires an origin, grant, session, and fetch.");
  }
  let sequence: any = 0;
  let stream: any = null;

  function headers({ method = "POST", url = `${origin}/mcp`, body = "", extraHeaders = {} }: Record<string, any> = {}) : any {
    return verifierMcpRequestHeaders({
      identityByToken: grant.identityByToken,
      token: grant.token,
      target: grant.target,
      method,
      url,
      body,
      extraHeaders: { [MCP_PROXY_SESSION_HEADER]: sessionId, ...extraHeaders }
    });
  }

  async function rpc(method?: any, params: Record<string, any> = {}) : Promise<any> {
    const url: any = `${origin}/mcp`;
    const body: any = JSON.stringify({ jsonrpc: "2.0", id: `peer-${++sequence}`, method, params });
    const response: any = await fetchImpl(url, { method: "POST", headers: headers({ body, url }), body });
    const payload: any = await response.json();
    return { status: response.status, payload };
  }

  async function openInvalidationStream() : Promise<any> {
    if (stream) throw new Error("Neutral peer stream is already open.");
    const controller: any = new AbortController();
    const events: any[] = [];
    const url: any = `${origin}/mcp`;
    const body: any = JSON.stringify({
      jsonrpc: "2.0",
      id: `peer-subscription-${++sequence}`,
      method: "subscriptions/listen",
      params: { notifications: [MCP_CATALOG_LIST_CHANGED_METHOD] }
    });
    const response: any = await fetchImpl(url, {
      method: "POST",
      headers: headers({
        method: "POST",
        url,
        body,
        extraHeaders: { Accept: "text/event-stream" }
      }),
      body,
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      controller.abort();
      return Object.freeze({ ok: false, status: response.status });
    }
    let resolveClosed: any;
    const closed: any = new Promise((resolve?: any) : any => { resolveClosed = resolve; });
    const read: any = (async () : Promise<any> => {
      const reader: any = response.body.getReader();
      const decoder: any = new TextDecoder();
      let buffer: any = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
          let boundary: any = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const payload: any = parseSsePayload(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (payload) events.push(payload);
            boundary = buffer.indexOf("\n\n");
          }
        }
        resolveClosed("closed");
      } catch (error: any) {
        if (error?.name === "AbortError") resolveClosed("aborted");
        else resolveClosed("closed");
      } finally {
        reader.releaseLock?.();
      }
    })();
    stream = {
      ok: true,
      status: response.status,
      events,
      async waitForInvalidation(timeoutMs: any = 5_000, { partitionKeys = [] }: Record<string, any> = {}) : Promise<any> {
        const deadline: any = Date.now() + timeoutMs;
        const expectedPartitions: any = new Set<any>(partitionKeys);
        while (Date.now() < deadline) {
          const event: any = events.find((entry?: any) : any => entry?.method === MCP_CATALOG_LIST_CHANGED_METHOD &&
            parseMcpCatalogInvalidation(entry?.params?.change) && (
              expectedPartitions.size === 0 ||
              entry.params.change.affectedPartitions.some((key?: any) : any => expectedPartitions.has(key))
            ));
          if (event) return event;
          await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
        }
        throw new Error("Neutral peer timed out waiting for catalog invalidation.");
      },
      waitForClose: () : any => closed,
      async close() : Promise<any> {
        controller.abort();
        await Promise.allSettled([read, closed]);
        stream = null;
      }
    };
    return stream;
  }

  async function pullCatalog({ timeoutMs = 5_000 }: Record<string, any> = {}) : Promise<any> {
    const deadline: any = Date.now() + timeoutMs;
    let lastFailure: any = "catalog_contract_incomplete";
    do {
      const result: any = await rpc("tools/list", {});
      const facts: any = parseMcpCatalogFacts(result.payload?.result?._meta?.catalogConvergence);
      if (result.status === 200 && facts && Array.isArray(result.payload?.result?.tools)) {
        return Object.freeze({ ...result, facts, tools: result.payload.result.tools });
      }
      lastFailure = `status_${Number(result.status || 0)}:${String(result.payload?.error?.data?.code || "catalog_contract_incomplete").slice(0, 96)}`;
      if ([401, 403].includes(result.status)) {
        const reasonCode: any = String(result.payload?.error?.data?.code || "neutral_peer_unauthorized");
        const error: Error & Record<string, any> = new Error(`Neutral peer catalog pull was not authorized: ${reasonCode}.`);
        error.code = reasonCode;
        throw error;
      }
      await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`Neutral peer catalog pull did not satisfy the protocol contract: ${lastFailure}.`);
  }

  async function acknowledge(facts?: any, partitionKeys: any = facts?.partitionKeys || []) : Promise<any> {
    return rpc(MCP_CATALOG_ACKNOWLEDGE_METHOD, {
      sourceRevision: facts?.sourceRevision,
      catalogRevision: facts?.catalogRevision,
      audienceRevision: facts?.audienceRevision,
      partitionKeys
    });
  }

  return Object.freeze({
    proxySessionId: sessionId,
    openInvalidationStream,
    pullCatalog,
    acknowledge,
    callTool: (name?: any, args: Record<string, any> = {}) : any => rpc("tools/call", { name, arguments: args })
  });
}
