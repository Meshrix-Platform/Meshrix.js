import { createHash, randomBytes } from "node:crypto";

import {
  authHeaders,
  installAuthenticatedFetch,
  installedAuthFor
} from "../test-auth-helper.mjs";

const approvalAuthByOrigin = new Map();

function responseError(payload = {}, fallback = "request failed") {
  return String(payload?.error?.message || payload?.error?.code || payload?.error || fallback);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function unauthenticatedDeviceHeaders(extra = {}) {
  return {
    Cookie: "",
    "x-lico-csrf": "",
    "x-lico-safety-confirm": "",
    ...extra
  };
}

async function resolveApprovalAuth(server, approvalAuth = null) {
  if (approvalAuth?.cookie && approvalAuth?.csrf) {
    return approvalAuth;
  }
  if (!server?.url) {
    throw new Error("Verifier MCP device authorization requires a real console session.");
  }
  const origin = new URL(server.url).origin;
  if (!approvalAuthByOrigin.has(origin)) {
    approvalAuthByOrigin.set(
      origin,
      installedAuthFor(server) || await installAuthenticatedFetch(server, { setProcessEnv: false })
    );
  }
  return approvalAuthByOrigin.get(origin);
}

export async function issueVerifierLocalMcpGrant({ server = null, baseUrl = "", approvalAuth = null, grantRequest = {} } = {}) {
  const serviceUrl = String(server?.url || baseUrl || "").replace(/\/+$/u, "");
  if (!serviceUrl) {
    throw new Error("Verifier MCP device authorization requires a server URL.");
  }
  const consoleAuth = await resolveApprovalAuth(server, approvalAuth);
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = createHash("sha256").update(claimToken, "utf8").digest("hex");
  const created = await requestJson(`${serviceUrl}/api/mcp/local-grant/requests`, {
    method: "POST",
    headers: unauthenticatedDeviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      ...grantRequest,
      claimTokenHash
    })
  });
  if (created.status !== 202 || !created.payload?.requestId) {
    throw new Error(`Verifier MCP authorization request failed: ${responseError(created.payload, `HTTP ${created.status}`)}`);
  }

  const requestId = String(created.payload.requestId);
  const approved = await requestJson(
    `${serviceUrl}/api/console/mcp/authorization/requests/${encodeURIComponent(requestId)}/resolve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(consoleAuth, { method: "POST", safetyConfirm: true })
      },
      body: JSON.stringify({ resolution: "approved" })
    }
  );
  if (approved.status !== 200 || approved.payload?.ok !== true) {
    throw new Error(`Verifier MCP authorization approval failed: ${responseError(approved.payload, `HTTP ${approved.status}`)}`);
  }

  const consumed = await requestJson(
    `${serviceUrl}/api/mcp/local-grant/requests/${encodeURIComponent(requestId)}/consume`,
    {
      method: "POST",
      headers: unauthenticatedDeviceHeaders({
        "Content-Type": "application/json",
        "x-lico-authorization-claim": claimToken
      }),
      body: "{}"
    }
  );
  if (consumed.status !== 201 || consumed.payload?.ok !== true) {
    throw new Error(`Verifier MCP authorization consumption failed: ${responseError(consumed.payload, `HTTP ${consumed.status}`)}`);
  }
  return consumed;
}
