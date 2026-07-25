// Release journey console control-plane client.
//
// Bootstraps the containerized owner account (documented rotation flow),
// opens a console session, publishes the upstream service through the
// authenticated control plane, and approves the connector device
// authorization. All secrets stay in memory and are registered as redaction
// needles; nothing in this module writes them to disk.
import { randomUUID } from "node:crypto";

import { runDocker } from "./release-journey-compose.mjs";

export const PUBLISHING_COMMAND_SCHEMA_VERSION = "v0.0.1:upstream-service-publishing:command-2";

export async function rotateOwnerPassword({ containerName, env, redact = (value) => value }) {
  const result = runDocker(
    ["exec", containerName, "node", "tools/server-scripts/console-auth.mjs", "set-password", "--username", "owner", "--generate-password"],
    { env, redact: (value) => value }
  );
  const match = /new password:\s*(\S+)/u.exec(result.stdout);
  if (!match) {
    const error = new Error(`Owner password rotation did not return a generated password: ${redact(result.stdout).slice(-400)}`);
    error.code = "release_journey_bootstrap_failed";
    throw error;
  }
  return match[1];
}

export function createConsoleClient({ baseUrl, addNeedle = () => {}, fetchImpl = fetch }) {
  let cookie = "";
  let csrfToken = "";

  async function api(pathname, { method = "GET", body = null, safetyConfirm = false, timeoutMs = 15000 } = {}) {
    const headers = { Accept: "application/json" };
    if (cookie) headers.Cookie = cookie;
    if (csrfToken) headers["x-meshrix-csrf"] = csrfToken;
    if (safetyConfirm) headers["x-meshrix-safety-confirm"] = "true";
    if (body !== null) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const setCookie = response.headers.get("set-cookie") || "";
    if (setCookie) {
      const sessionCookie = setCookie.split(";")[0];
      if (sessionCookie.includes("=")) {
        cookie = sessionCookie;
        addNeedle(sessionCookie);
      }
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { parseError: text.slice(0, 200) };
    }
    if (typeof payload?.csrfToken === "string" && payload.csrfToken) {
      csrfToken = payload.csrfToken;
      addNeedle(csrfToken);
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async function login({ username = "owner", password }) {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: { username, password }
    });
    if (!result.ok || result.payload?.ok !== true) {
      const error = new Error(`Console login failed with status ${result.status}.`);
      error.code = "release_journey_login_failed";
      throw error;
    }
    if (!csrfToken) {
      const error = new Error("Console login did not return a CSRF token.");
      error.code = "release_journey_login_failed";
      throw error;
    }
    return { username, roleId: String(result.payload?.session?.user?.roleId || "") };
  }

  return { api, login };
}

export async function publishUpstreamService({
  consoleClient,
  descriptorDocument,
  fetchImpl = fetch,
  pollIntervalMs = 1000,
  publishTimeoutMs = 60000
}) {
  const serviceKey = String(descriptorDocument?.serviceKey || "");
  const descriptor = descriptorDocument?.descriptor;
  if (!serviceKey || !descriptor || typeof descriptor !== "object") {
    const error = new Error("The upstream descriptor document is invalid.");
    error.code = "release_journey_descriptor_invalid";
    throw error;
  }
  const list = await consoleClient.api("/api/gateway/v1/services");
  if (!list.ok) {
    const error = new Error(`Listing gateway services failed with status ${list.status}.`);
    error.code = "release_journey_publish_failed";
    throw error;
  }
  const command = {
    schemaVersion: PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    expectedServiceRevision: 0,
    expectedSetRevision: Number(list.payload?.setRevision || 0),
    idempotencyKey: `create:${randomUUID()}`,
    serviceKey,
    descriptor
  };
  const created = await consoleClient.api("/api/gateway/v1/services", {
    method: "POST",
    body: command
  });
  if (!created.ok || created.payload?.ok !== true || !created.payload?.serviceId) {
    const error = new Error(`Upstream publish was rejected with status ${created.status}.`);
    error.code = "release_journey_publish_failed";
    throw error;
  }
  const serviceId = String(created.payload.serviceId);
  const receipt = {
    serviceId,
    state: String(created.payload.state || ""),
    serviceRevision: Number(created.payload.serviceRevision || 0),
    setRevision: Number(created.payload.setRevision || 0),
    manifestDigest: String(created.payload.manifestDigest || "")
  };

  const deadline = Date.now() + publishTimeoutMs;
  let publication = null;
  while (Date.now() < deadline) {
    const detail = await consoleClient.api(`/api/gateway/v1/services/${encodeURIComponent(serviceId)}`);
    publication = detail.payload?.service?.publication || null;
    if (publication?.status === "server_published") break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  if (publication?.status !== "server_published") {
    const error = new Error("Upstream publication did not reach server_published in time.");
    error.code = "release_journey_publish_timeout";
    throw error;
  }
  receipt.publication = {
    status: "server_published",
    sourceRevision: Number(publication?.terminal?.sourceRevision || 0),
    sourceDigest: String(publication?.terminal?.sourceDigest || ""),
    catalogRevision: String(publication?.terminal?.catalogRevision || ""),
    audienceRevision: Number(publication?.terminal?.audienceRevision || 0),
    protocolRevision: Number(publication?.terminal?.protocolRevision || 0)
  };

  const health = await consoleClient.api(`/api/gateway/v1/external-services/${encodeURIComponent(serviceId)}/health`);
  receipt.health = {
    ok: health.payload?.ok === true,
    status: Number(health.payload?.status || 0),
    healthyEndpoints: Number(health.payload?.healthyEndpointCount || 0),
    endpoints: Number(health.payload?.endpointCount || 0)
  };
  if (!receipt.health.ok) {
    const error = new Error("Published upstream service is not healthy.");
    error.code = "release_journey_upstream_unhealthy";
    throw error;
  }
  return receipt;
}

export async function listPendingAuthorizationRequests(consoleClient) {
  const result = await consoleClient.api("/api/console/mcp/authorization/requests?status=pending");
  if (!result.ok) return [];
  return Array.isArray(result.payload?.requests) ? result.payload.requests : [];
}

export async function approveAuthorizationRequest(consoleClient, requestId) {
  const result = await consoleClient.api(
    `/api/console/mcp/authorization/requests/${encodeURIComponent(requestId)}/resolve`,
    { method: "POST", body: { resolution: "approved" }, safetyConfirm: true }
  );
  if (!result.ok || result.payload?.ok !== true) {
    const error = new Error(`Approving MCP device authorization ${requestId} failed with status ${result.status}.`);
    error.code = "release_journey_approval_failed";
    throw error;
  }
  return { requestId, approved: true };
}
