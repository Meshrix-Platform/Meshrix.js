import { createHash, randomBytes } from "node:crypto";

import {
  authHeaders,
  installAuthenticatedFetch,
  installedAuthFor
} from "../test-auth-helper.ts";

const approvalAuthByOrigin: any = new Map<any, any>();

function responseError(payload: Record<string, any> = {}, fallback: any = "request failed") : any {
  return String(payload?.error?.message || payload?.error?.code || payload?.error || fallback);
}

async function requestJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function unauthenticatedDeviceHeaders(extra: Record<string, any> = {}) : any {
  return {
    Cookie: "",
    "x-meshrix-csrf": "",
    "x-meshrix-safety-confirm": "",
    ...extra
  };
}

async function resolveApprovalAuth(server?: any, approvalAuth: any = null) : Promise<any> {
  if (approvalAuth?.cookie && approvalAuth?.csrf) {
    return approvalAuth;
  }
  if (!server?.url) {
    throw new Error("Verifier MCP device authorization requires a real console session.");
  }
  const origin: any = new URL(server.url).origin;
  if (!approvalAuthByOrigin.has(origin)) {
    approvalAuthByOrigin.set(
      origin,
      installedAuthFor(server) || await installAuthenticatedFetch(server, { setProcessEnv: false })
    );
  }
  return approvalAuthByOrigin.get(origin);
}

export async function issueVerifierLocalMcpGrant({ server = null, baseUrl = "", approvalAuth = null, grantRequest = {} }: Record<string, any> = {}) : Promise<any> {
  const serviceUrl: any = String(server?.url || baseUrl || "").replace(/\/+$/u, "");
  if (!serviceUrl) {
    throw new Error("Verifier MCP device authorization requires a server URL.");
  }
  const consoleAuth: any = await resolveApprovalAuth(server, approvalAuth);
  const claimToken: any = randomBytes(32).toString("base64url");
  const claimTokenHash: any = createHash("sha256").update(claimToken, "utf8").digest("hex");
  const created: any = await requestJson(`${serviceUrl}/api/mcp/local-grant/requests`, {
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

  const requestId: any = String(created.payload.requestId);
  const approved: any = await requestJson(
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

  const consumed: any = await requestJson(
    `${serviceUrl}/api/mcp/local-grant/requests/${encodeURIComponent(requestId)}/consume`,
    {
      method: "POST",
      headers: unauthenticatedDeviceHeaders({
        "Content-Type": "application/json",
        "x-meshrix-authorization-claim": claimToken
      }),
      body: "{}"
    }
  );
  if (consumed.status !== 201 || consumed.payload?.ok !== true) {
    throw new Error(`Verifier MCP authorization consumption failed: ${responseError(consumed.payload, `HTTP ${consumed.status}`)}`);
  }
  return consumed;
}
