import { randomBytes } from "node:crypto";
import { verifyMcpHandshakeSignature } from "@lico/protocols/mcp/adapter/mcp-identity";
import { MCP_PROTOCOL_VERSION } from "@lico/protocols/mcp/adapter/http-mcp-adapter-constants";

const PROBE_TIMEOUT_MS = 2_500;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;

function probeUrl(baseUrl, pathname) {
  const base = new URL(baseUrl);
  base.pathname = pathname;
  base.search = "";
  base.hash = "";
  return base.toString();
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_PROBE_RESPONSE_BYTES) {
    throw new Error("probe_response_too_large");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PROBE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("probe_response_too_large");
    }
    chunks.push(value);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8"));
}

async function requestJson(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...options,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    return { response, payload: await readBoundedJson(response) };
  } finally {
    clearTimeout(timeout);
  }
}

function samePublicKey(left, right) {
  return left?.kty === right?.kty && left?.crv === right?.crv && left?.x === right?.x;
}

function validHandshakeIdentity({ payload, expectedIdentity, nonce }) {
  const handshake = payload?.payload || {};
  const signature = payload?.signature || {};
  return payload?.ok === true &&
    handshake.schemaVersion === "v0.0.1:mcp:handshake-1" &&
    handshake.nonce === nonce &&
    handshake.server?.name === "LicoMesh" &&
    handshake.identity?.keyId === expectedIdentity.keyId &&
    samePublicKey(handshake.identity?.publicKeyJwk, expectedIdentity.publicKeyJwk) &&
    signature.algorithm === "Ed25519" &&
    verifyMcpHandshakeSignature({
      publicKeyJwk: expectedIdentity.publicKeyJwk,
      payload: handshake,
      signature: signature.value,
    });
}

async function closeMcpSession(fetchImpl, baseUrl, sessionId) {
  if (!sessionId) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetchImpl(probeUrl(baseUrl, "/mcp"), {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    // Probe cleanup is best-effort and cannot publish or reject a generation.
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeExternalGatewayEndpoint({ profile, expectedIdentity, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function" || !expectedIdentity?.keyId || !expectedIdentity?.publicKeyJwk) {
    return Object.freeze({ ok: false, reason: "external_gateway_probe_unavailable" });
  }
  const baseUrl = profile.gatewayMode.publicBaseUrl;
  const adapterId = profile.gatewayMode.adapterId;

  try {
    const health = await requestJson(fetchImpl, probeUrl(baseUrl, "/api/healthz"));
    if (!health.response.ok || health.payload?.ok !== true) {
      return Object.freeze({ ok: false, reason: "external_gateway_health_probe_failed" });
    }
  } catch {
    return Object.freeze({ ok: false, reason: "external_gateway_health_probe_failed" });
  }

  const nonce = randomBytes(32).toString("base64url");
  try {
    const handshake = await requestJson(fetchImpl, probeUrl(baseUrl, "/api/mcp/handshake"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nonce,
        client: { name: "LicoMesh External Gateway Probe", version: "1" },
      }),
    });
    if (!handshake.response.ok || !validHandshakeIdentity({
      payload: handshake.payload,
      expectedIdentity,
      nonce,
    })) {
      return Object.freeze({ ok: false, reason: "external_gateway_identity_probe_failed" });
    }
    const transit = handshake.payload?.payload?.externalGateway || {};
    if (transit.adapterId !== adapterId || transit.route !== "/api/mcp/handshake" ||
      transit.requestIdPresent !== true) {
      return Object.freeze({ ok: false, reason: "external_gateway_adapter_probe_failed" });
    }
  } catch {
    return Object.freeze({ ok: false, reason: "external_gateway_identity_probe_failed" });
  }

  let sessionId = "";
  try {
    const initialized = await requestJson(fetchImpl, probeUrl(baseUrl, "/mcp"), {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "external-gateway-probe",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "LicoMesh External Gateway Probe", version: "1" },
        },
      }),
    });
    sessionId = String(initialized.response.headers.get("mcp-session-id") || "").trim();
    if (!initialized.response.ok || initialized.payload?.result?.serverInfo?.name !== "LicoMesh" ||
      initialized.payload?.result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      return Object.freeze({ ok: false, reason: "external_gateway_mcp_probe_failed" });
    }
  } catch {
    return Object.freeze({ ok: false, reason: "external_gateway_mcp_probe_failed" });
  } finally {
    await closeMcpSession(fetchImpl, baseUrl, sessionId);
  }

  return Object.freeze({ ok: true });
}
