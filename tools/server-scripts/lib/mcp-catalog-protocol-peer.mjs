import assert from "node:assert/strict";

import {
  MCP_CATALOG_ACKNOWLEDGE_METHOD,
  MCP_CATALOG_LIST_CHANGED_CAPABILITY,
  MCP_CATALOG_LIST_CHANGED_METHOD,
  MCP_PROXY_SESSION_HEADER,
  normalizeMcpProxySessionId,
  parseMcpCatalogFacts,
  parseMcpCatalogInvalidation
} from "../../../packages/contracts/src/mcp-catalog-delivery.mjs";
import { issueVerifierLocalMcpGrant } from "./local-mcp-device-authorization.mjs";
import {
  bindVerifierLocalMcpGrantIdentity,
  createVerifierLocalMcpGrantIdentity,
  verifierMcpRequestHeaders
} from "./local-mcp-verifier-identity.mjs";

// This is a protocol negotiation value accepted by the server grant endpoint.
// The verifier remains a neutral wire peer and imports no client implementation.
const PEER_TARGET = "codex";

function parseSsePayload(block) {
  const data = String(block || "").split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
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
  maxRisk = "read_only"
} = {}) {
  const normalizedPeerId = String(peerId || "primary").replace(/[^a-z0-9-]+/giu, "-").slice(0, 48);
  const target = PEER_TARGET;
  const identityByToken = new Map();
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target,
    label: `neutral-protocol-peer-${normalizedPeerId}`
  });
  const response = await issueVerifierLocalMcpGrant({
    server,
    approvalAuth,
    grantRequest: {
      targets: [target],
      label: "Neutral protocol peer",
      connectorVersion: "protocol-peer",
      grantMode: "maintain",
      maxRisk,
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      processIdentity: verifierIdentity.request
    }
  });
  const token = String(response.payload.token || "");
  const grantId = String(response.payload.grantId || response.payload.grant?.id || "");
  assert.ok(token && grantId, "Neutral protocol grant issuance failed.");
  bindVerifierLocalMcpGrantIdentity({
    identityByToken,
    token,
    identity: verifierIdentity.identity,
    payload: response.payload
  });
  return Object.freeze({ token, grantId, identityByToken, target });
}

export function createMcpCatalogProtocolPeer({
  baseUrl,
  grant,
  proxySessionId,
  fetchImpl = globalThis.fetch
} = {}) {
  const origin = String(baseUrl || "").replace(/\/+$/u, "");
  const sessionId = normalizeMcpProxySessionId(proxySessionId);
  if (!origin || !grant?.token || !grant?.identityByToken || !sessionId || typeof fetchImpl !== "function") {
    throw new TypeError("Neutral MCP protocol peer requires an origin, grant, session, and fetch.");
  }
  let sequence = 0;
  let stream = null;

  function headers({ method = "POST", url = `${origin}/mcp`, body = "", extraHeaders = {} } = {}) {
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

  async function rpc(method, params = {}) {
    const url = `${origin}/mcp`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: `peer-${++sequence}`, method, params });
    const response = await fetchImpl(url, { method: "POST", headers: headers({ body, url }), body });
    const payload = await response.json();
    return { status: response.status, payload };
  }

  async function openInvalidationStream() {
    if (stream) throw new Error("Neutral peer stream is already open.");
    const controller = new AbortController();
    const events = [];
    const url = new URL("/mcp", `${origin}/`);
    url.searchParams.set("capability", MCP_CATALOG_LIST_CHANGED_CAPABILITY);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: headers({
        method: "GET",
        url: url.toString(),
        extraHeaders: { Accept: "text/event-stream" }
      }),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      controller.abort();
      return Object.freeze({ ok: false, status: response.status });
    }
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const read = (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const payload = parseSsePayload(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (payload) events.push(payload);
            boundary = buffer.indexOf("\n\n");
          }
        }
        resolveClosed("closed");
      } catch (error) {
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
      async waitForInvalidation(timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const event = events.find((entry) => entry?.method === MCP_CATALOG_LIST_CHANGED_METHOD &&
            parseMcpCatalogInvalidation(entry?.params?.change));
          if (event) return event;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Neutral peer timed out waiting for catalog invalidation.");
      },
      waitForClose: () => closed,
      async close() {
        controller.abort();
        await Promise.allSettled([read, closed]);
        stream = null;
      }
    };
    return stream;
  }

  async function pullCatalog({ timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await rpc("tools/list", {});
      const facts = parseMcpCatalogFacts(result.payload?.result?._meta?.catalogConvergence);
      if (result.status === 200 && facts && Array.isArray(result.payload?.result?.tools)) {
        return Object.freeze({ ...result, facts, tools: result.payload.result.tools });
      }
      if ([401, 403].includes(result.status)) {
        const reasonCode = String(result.payload?.error?.data?.code || "neutral_peer_unauthorized");
        const error = new Error(`Neutral peer catalog pull was not authorized: ${reasonCode}.`);
        error.code = reasonCode;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error("Neutral peer catalog pull did not satisfy the protocol contract.");
  }

  async function acknowledge(facts, partitionKeys = facts?.partitionKeys || []) {
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
    callTool: (name, args = {}) => rpc("tools/call", { name, arguments: args })
  });
}
