// Release journey console control-plane client.
//
// Bootstraps the containerized owner account (documented rotation flow),
// opens a console session, publishes the upstream service through the
// authenticated control plane, and approves the connector device
// authorization. All secrets stay in memory and are registered as redaction
// needles; nothing in this module writes them to disk.
import { runDocker } from "./release-journey-compose.ts";

export async function rotateOwnerPassword({ containerName, env, redact = (value?: any) : any => value }: Record<string, any>) : Promise<any> {
  const result: any = runDocker(
    ["exec", containerName, "node", "tools/server-scripts/console-auth.ts", "set-password", "--username", "owner", "--generate-password"],
    { env, redact: (value?: any) : any => value }
  );
  const match: any = /new password:\s*(\S+)/u.exec(result.stdout);
  if (!match) {
    const error: Error & Record<string, any> = new Error(`Owner password rotation did not return a generated password: ${redact(result.stdout).slice(-400)}`);
    error.code = "release_journey_bootstrap_failed";
    throw error;
  }
  return match[1];
}

export function createConsoleClient({ baseUrl, addNeedle = () : any => {}, fetchImpl = fetch }: Record<string, any>) : any {
  let cookie: any = "";
  let csrfToken: any = "";

  async function api(pathname?: any, { method = "GET", body = null, safetyConfirm = false, timeoutMs = 15000 }: Record<string, any> = {}) : Promise<any> {
    const headers: Record<string, any> = { Accept: "application/json" };
    if (cookie) headers.Cookie = cookie;
    if (csrfToken) headers["x-meshrix-csrf"] = csrfToken;
    if (safetyConfirm) headers["x-meshrix-safety-confirm"] = "true";
    if (body !== null) headers["Content-Type"] = "application/json";
    const response: any = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const setCookie: any = response.headers.get("set-cookie") || "";
    if (setCookie) {
      const sessionCookie: any = setCookie.split(";")[0];
      if (sessionCookie.includes("=")) {
        cookie = sessionCookie;
        addNeedle(sessionCookie);
      }
    }
    const text: any = await response.text();
    let payload: any = null;
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

  async function login({ username = "owner", password }: Record<string, any>) : Promise<any> {
    const result: any = await api("/api/auth/login", {
      method: "POST",
      body: { username, password }
    });
    if (!result.ok || result.payload?.ok !== true) {
      const error: Error & Record<string, any> = new Error(`Console login failed with status ${result.status}.`);
      error.code = "release_journey_login_failed";
      throw error;
    }
    if (!csrfToken) {
      const error: Error & Record<string, any> = new Error("Console login did not return a CSRF token.");
      error.code = "release_journey_login_failed";
      throw error;
    }
    const scopes: any[] = Array.isArray(result.payload?.session?.user?.scopes)
      ? result.payload.session.user.scopes.map((scope?: any) : any => String(scope || ""))
      : [];
    return {
      username,
      roleId: String(result.payload?.session?.user?.roleId || ""),
      runtimeAdministrationAuthorized: scopes.includes("runtime:admin")
    };
  }

  return { api, login };
}

export async function inspectPublishedUpstreamService({
  consoleClient,
  serviceId,
  pollIntervalMs = 500,
  publishTimeoutMs = 60_000
}: Record<string, any>) : Promise<any> {
  const deadline: any = Date.now() + publishTimeoutMs;
  let service: any = null;
  let setRevision: any = 0;
  while (Date.now() < deadline) {
    const detail: any = await consoleClient.api(
      `/api/gateway/v1/services/${encodeURIComponent(serviceId)}`
    );
    setRevision = Number(detail.payload?.setRevision || 0);
    service = detail.payload?.service || null;
    if (
      service?.publication?.status === "server_published"
      || service?.state === "server_published"
    ) break;
    await new Promise((resolve?: any) : any => setTimeout(resolve, pollIntervalMs));
  }
  if (
    service?.publication?.status !== "server_published"
    && service?.state !== "server_published"
  ) {
    const error: Error & Record<string, any> = new Error("Console publication did not reach server_published in time.");
    error.code = "release_journey_publish_timeout";
    throw error;
  }
  const health: any = await consoleClient.api(
    `/api/gateway/v1/external-services/${encodeURIComponent(service.serviceId)}/health`
  );
  if (health.payload?.ok !== true) {
    const error: Error & Record<string, any> = new Error("Published upstream service is not healthy.");
    error.code = "release_journey_upstream_unhealthy";
    throw error;
  }
  return {
    serviceId: String(service.serviceId),
    state: String(service.state || ""),
    serviceRevision: Number(service.serviceRevision || 0),
    setRevision,
    manifestDigest: String(service.manifestDigest || ""),
    publication: {
      status: "server_published",
      sourceRevision: Number(service.publication?.terminal?.sourceRevision || 0),
      sourceDigest: String(service.publication?.terminal?.sourceDigest || ""),
      catalogRevision: String(service.publication?.terminal?.catalogRevision || ""),
      audienceRevision: Number(service.publication?.terminal?.audienceRevision || 0),
      protocolRevision: Number(service.publication?.terminal?.protocolRevision || 0)
    },
    health: {
      ok: true,
      status: Number(health.payload?.status || 0),
      healthyEndpoints: Number(health.payload?.healthyEndpointCount || 0),
      endpoints: Number(health.payload?.endpointCount || 0)
    }
  };
}

export async function listPendingOperations(consoleClient?: any, { status = "pending", limit = 100 }: Record<string, any> = {}) : Promise<any> {
  const result: any = await consoleClient.api(
    `/api/operation-permission/v1/pending-operations?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}`
  );
  if (!result.ok) return [];
  return Array.isArray(result.payload?.pendingOperations) ? result.payload.pendingOperations : [];
}

export async function listOperationAudit(consoleClient?: any, { toolId = "", status = "", limit = 100 }: Record<string, any> = {}) : Promise<any> {
  const query: any = new URLSearchParams({
    limit: String(limit),
    ...(toolId ? { toolId } : {}),
    ...(status ? { status } : {})
  });
  const result: any = await consoleClient.api(`/api/operation-permission/v1/audit?${query}`);
  if (!result.ok) return [];
  return Array.isArray(result.payload?.items) ? result.payload.items : [];
}
