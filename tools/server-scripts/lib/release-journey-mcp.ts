// Release journey MCP driver and artifact download.
//
// Drives the deterministic release scenario over the real connector stdio
// proxy — the identical transport an MCP client such as Kimi CLI uses — via
// the shared neutral-peer stdio client, then downloads the produced artifact
// through the connector `fetch` command following the returned resource_link
// URL.
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { createMcpProxyStdioClient } from "./mcp-proxy-stdio-client.ts";
import { authHeaders } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
import { processIdentityHeaders } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/process-identity-request.ts";
import { resolveProxyCredentials } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";

// Client-side mirror of packages/agents/src/upstream-gateway/support.ts
// safePublicToolSegment; the server remains the source of truth and the
// tools/list assertion below fails closed on any drift.
export function safePublicToolSegment(value: any = "") : any {
  return String(value)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "service";
}

function contentItemsOf(result?: any) : any {
  return result?.result?.content || result?.content || [];
}

async function jsonResponse(response?: any) : Promise<any> {
  const text: any = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export async function uploadBinaryFixtureThroughConnector({
  target = "kimi",
  baseUrl,
  fixtureBytes,
  fixtureFileName,
  addNeedle = () : any => {},
  fetchImpl = fetch,
  resolveCredentials = resolveProxyCredentials,
  buildIdentityHeaders = processIdentityHeaders
}: Record<string, any> = {}) : Promise<any> {
  if (!Buffer.isBuffer(fixtureBytes) || fixtureBytes.length === 0) {
    throw new TypeError("uploadBinaryFixtureThroughConnector requires non-empty fixture bytes.");
  }
  const normalizedBaseUrl: any = String(baseUrl || "").replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(normalizedBaseUrl)) {
    throw new TypeError("uploadBinaryFixtureThroughConnector requires a server base URL.");
  }
  const { token, identity } = await resolveCredentials({ target });
  addNeedle(token);
  const fileName: any = String(fixtureFileName || "fixture.bin");
  const sha256: any = createHash("sha256").update(fixtureBytes).digest("hex");
  const manifestDigest: any = createHash("sha256")
    .update("release-journey-upload\0")
    .update(sha256)
    .digest("hex");
  const createUrl: any = new URL("/api/upload-sessions", normalizedBaseUrl);
  const createBody: any = JSON.stringify({
    checkpoint: { checkpointId: `release-journey-${sha256.slice(0, 16)}` },
    manifest: { manifestDigest, inputDigest: sha256 },
    files: [{
      relativePath: fileName,
      sha256,
      byteSize: fixtureBytes.length,
      mediaType: "text/plain; charset=utf-8"
    }]
  });
  const createIdentityHeaders: any = buildIdentityHeaders({
    method: "POST",
    url: createUrl,
    body: createBody,
    identity
  });
  if (!createIdentityHeaders["x-meshrix-signature"]) {
    const error: Error & Record<string, any> = new Error("Connector process identity is required for binary upload.");
    error.code = "release_journey_upload_identity_missing";
    throw error;
  }
  const createdResponse: any = await fetchImpl(createUrl, {
    method: "POST",
    headers: {
      ...authHeaders(token, target),
      ...createIdentityHeaders
    },
    body: createBody,
    signal: AbortSignal.timeout(120_000)
  });
  const created: any = await jsonResponse(createdResponse);
  const sessionId: any = String(created?.sessionId || "");
  if (!createdResponse.ok || !sessionId) {
    const error: Error & Record<string, any> = new Error(`Connector binary upload session creation failed with status ${createdResponse.status}.`);
    const reasonCode: any = String(created?.error?.code || created?.reasonCode || created?.code || "")
      .replace(/[^a-z0-9_]+/giu, "_")
      .slice(0, 80);
    error.code = reasonCode
      ? `release_journey_upload_session_${reasonCode}`
      : "release_journey_upload_session_failed";
    error.statusCode = Number(createdResponse.status || 0);
    throw error;
  }
  addNeedle(sessionId);

  const uploadUrl: any = new URL(
    `/api/upload-sessions/${encodeURIComponent(sessionId)}/files/0?offset=0`,
    normalizedBaseUrl
  );
  const uploadIdentityHeaders: any = buildIdentityHeaders({
    method: "PUT",
    url: uploadUrl,
    body: fixtureBytes,
    identity
  });
  if (!uploadIdentityHeaders["x-meshrix-signature"]) {
    const error: Error & Record<string, any> = new Error("Connector process identity is required for binary upload.");
    error.code = "release_journey_upload_identity_missing";
    throw error;
  }
  const uploadedResponse: any = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      ...authHeaders(token, target),
      "Content-Type": "application/octet-stream",
      ...uploadIdentityHeaders
    },
    body: fixtureBytes,
    signal: AbortSignal.timeout(120_000)
  });
  const uploaded: any = await jsonResponse(uploadedResponse);
  const file: any = uploaded?.files?.[0] || null;
  if (
    !uploadedResponse.ok
    || uploaded?.status !== "complete"
    || Number(file?.receivedBytes || file?.byteSize || 0) !== fixtureBytes.length
  ) {
    const error: Error & Record<string, any> = new Error(`Connector binary upload chunk failed with status ${uploadedResponse.status}.`);
    error.code = "release_journey_upload_chunk_failed";
    error.statusCode = Number(uploadedResponse.status || 0);
    throw error;
  }
  return {
    reference: `upload:${sessionId}:0`,
    receipt: {
      transport: "connector-authenticated-upload-session",
      contentType: "application/octet-stream",
      contentEncoding: "identity",
      base64Encoded: false,
      chunkCount: 1,
      byteLength: fixtureBytes.length,
      sha256,
      reference: "upload:<session-id>:0",
      ownerBound: true,
      processIdentityBound: true,
      status: "complete"
    }
  };
}

export async function runConnectorBinaryUpload({
  childScript,
  target = "kimi",
  baseUrl,
  fixtureBytes,
  fixtureFileName,
  env = {},
  addNeedle = () : any => {},
  timeoutMs = 120_000
}: Record<string, any> = {}) : Promise<any> {
  if (!Buffer.isBuffer(fixtureBytes) || fixtureBytes.length === 0) {
    throw new TypeError("runConnectorBinaryUpload requires non-empty fixture bytes.");
  }
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(
      process.execPath,
      [childScript, baseUrl, target, String(fixtureFileName || "fixture.bin")],
      {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout: any = "";
    let stderr: any = "";
    const timer: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      const error: Error & Record<string, any> = new Error("Connector binary upload child timed out.");
      error.code = "release_journey_upload_timeout";
      reject(error);
    }, timeoutMs);
    child.stdout.on("data", (chunk?: any) : any => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk?: any) : any => {
      if (stderr.length < 16 * 1024) stderr += chunk;
    });
    child.once("error", (error?: any) : any => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code?: any) : any => {
      clearTimeout(timer);
      let payload: any = null;
      try {
        payload = JSON.parse(stdout.trim());
      } catch {
        payload = null;
      }
      if (code !== 0 || !payload?.reference || payload?.receipt?.status !== "complete") {
        let errorCode: any = "release_journey_binary_upload_failed";
        try {
          const childError: any = JSON.parse(stderr.trim());
          errorCode = String(childError?.code || errorCode);
          const statusCode: any = Number(childError?.statusCode || 0);
          if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
            errorCode = `${errorCode}_http_${statusCode}`;
          }
        } catch {
          // Child errors are deliberately reduced to a fixed code.
        }
        const error: Error & Record<string, any> = new Error("Connector binary upload child failed.");
        error.code = errorCode;
        reject(error);
        return;
      }
      const sessionId: any = String(payload.reference).split(":")[1] || "";
      addNeedle(sessionId);
      resolve(payload);
    });
    child.stdin.end(fixtureBytes);
  });
}

export async function runMcpJourney({
  connectorScript,
  target = "kimi",
  baseUrl,
  serviceId,
  fixtureBytes,
  fixtureFileName,
  artifactReference,
  operationKey = "convert-full-access-debug",
  expectedOperationKeys = [
    "convert-require-approval-debug",
    "convert-full-access-debug"
  ],
  env = {},
  redact = (value?: any) : any => value,
  callTimeoutMs = 120000
}: Record<string, any> = {}) : Promise<any> {
  if (!Buffer.isBuffer(fixtureBytes) || fixtureBytes.length === 0) {
    throw new TypeError("runMcpJourney requires the fixture bytes.");
  }
  const fixtureSha256: any = createHash("sha256").update(fixtureBytes).digest("hex");
  const fileName: any = String(fixtureFileName || "fixture.txt");
  if (!/^upload:[^:]+:\d+$/u.test(String(artifactReference || ""))) {
    throw new TypeError("runMcpJourney requires an owner-bound upload artifact reference.");
  }
  const convertToolName: any = `upstream.${safePublicToolSegment(serviceId)}.${safePublicToolSegment(operationKey)}`;
  const expectedUpstreamTools: any = expectedOperationKeys.map(
    (key?: any) : any => `upstream.${safePublicToolSegment(serviceId)}.${safePublicToolSegment(key)}`
  );
  const receipt: Record<string, any> = { fixture: { name: fileName, byteLength: fixtureBytes.length, sha256: fixtureSha256 } };

  const client: any = createMcpProxyStdioClient({
    connectorScript,
    target,
    baseUrl,
    env,
    timeoutMs: callTimeoutMs,
    redactText: redact
  });
  try {
    const initialize: any = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-journey-gate", version: "0.0.1" }
    });
    receipt.initialize = {
      serverName: String(initialize?.result?.serverInfo?.name || ""),
      protocolVersion: String(initialize?.result?.protocolVersion || "")
    };
    await client.notify("notifications/initialized", {});

    const toolsList: any = await client.request("tools/list", {});
    const toolNames: any = (toolsList?.result?.tools || []).map((tool?: any) : any => tool.name);
    receipt.tools = toolNames;
    for (const expected of ["meshrix.discovery", "meshrix.gateway", ...expectedUpstreamTools]) {
      if (!toolNames.includes(expected)) {
        const error: Error & Record<string, any> = new Error(`Expected MCP tool ${expected} is not visible; saw ${toolNames.join(", ")}.`);
        error.code = "release_journey_tool_missing";
        throw error;
      }
    }
    const converted: any = await client.request("tools/call", {
      name: convertToolName,
      arguments: { arguments: { file: artifactReference, targetFormat: "pdf" } }
    }, { timeoutMs: Math.max(callTimeoutMs, 180000) });
    const items: any = contentItemsOf(converted);
    const resourceLink: any = items.find((item?: any) : any => item?.type === "resource_link") || null;
    const textItem: any = items.find((item?: any) : any => item?.type === "text") || null;
    if (!resourceLink?.uri) {
      const error: Error & Record<string, any> = new Error("Convert result does not contain a resource_link item.");
      error.code = "release_journey_resource_link_missing";
      throw error;
    }
    if (!textItem?.text) {
      const error: Error & Record<string, any> = new Error("Convert result does not contain the operator-facing text receipt.");
      error.code = "release_journey_text_receipt_missing";
      throw error;
    }
    const linkUrl: any = new URL(resourceLink.uri);
    const base: any = new URL(baseUrl);
    if (linkUrl.origin !== base.origin) {
      const error: Error & Record<string, any> = new Error("Artifact resource_link origin does not match the advertised server origin.");
      error.code = "release_journey_resource_origin_mismatch";
      throw error;
    }
    if (!/^\/api\/gateway\/v1\/artifacts\/[^/]+$/u.test(linkUrl.pathname)) {
      const error: Error & Record<string, any> = new Error("Artifact resource_link does not target the gateway artifact route.");
      error.code = "release_journey_resource_route_invalid";
      throw error;
    }
    receipt.convert = {
      tool: convertToolName,
      reference: "upload:<session-id>:0",
      artifactId: decodeURIComponent(linkUrl.pathname.split("/").pop() || ""),
      artifactName: String(resourceLink.name || ""),
      mediaType: String(resourceLink.mimeType || ""),
      size: Number(resourceLink.size || 0),
      contentTypes: items.map((item?: any) : any => item.type),
      resourceOriginMatchesAdvertised: true,
      artifactUrl: linkUrl.toString()
    };
    return { receipt, artifactUrl: linkUrl.toString(), artifactId: receipt.convert.artifactId };
  } finally {
    await client.close().catch(() : any => {});
  }
}

function findObjectField(value?: any, field?: any, depth: any = 0) : any {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, field)) return value[field];
  for (const child of (Object.values(value) as any[])) {
    const found: any = findObjectField(child, field, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function runMcpApprovalRequest({
  connectorScript,
  target,
  baseUrl,
  serviceId,
  artifactReference,
  operationKey = "convert-require-approval-debug",
  env = {},
  redact = (value?: any) : any => value,
  callTimeoutMs = 120000
}: Record<string, any> = {}) : Promise<any> {
  if (!/^upload:[^:]+:\d+$/u.test(String(artifactReference || ""))) {
    throw new TypeError("runMcpApprovalRequest requires an owner-bound upload artifact reference.");
  }
  const toolName: any = `upstream.${safePublicToolSegment(serviceId)}.${safePublicToolSegment(operationKey)}`;
  const client: any = createMcpProxyStdioClient({
    connectorScript,
    target,
    baseUrl,
    env,
    timeoutMs: callTimeoutMs,
    redactText: redact
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-journey-approval-gate", version: "0.0.1" }
    });
    await client.notify("notifications/initialized", {});
    const pending: any = await client.request("tools/call", {
      name: toolName,
      arguments: { arguments: { file: artifactReference, targetFormat: "pdf" } }
    }, { timeoutMs: Math.max(callTimeoutMs, 180000) });
    const status: any = String(findObjectField(pending, "status") || "");
    const pendingOperationId: any = String(findObjectField(pending, "pendingOperationId") || "");
    if (status !== "pending_approval" || !pendingOperationId) {
      const error: Error & Record<string, any> = new Error("Approval-required MCP operation did not enter pending_approval.");
      error.code = "release_journey_approval_not_pending";
      throw error;
    }
    return {
      tool: toolName,
      status,
      pendingOperationId
    };
  } finally {
    await client.close().catch(() : any => {});
  }
}

export async function runConnectorFetch({
  connectorScript,
  target = "kimi",
  artifactUrl,
  outputPath,
  env = {},
  timeoutMs = 120000
}: Record<string, any> = {}) : Promise<any> {
  const candidateUrl: any = String(artifactUrl || "").trim();
  if (!/^https?:\/\//iu.test(candidateUrl)) {
    const error: Error & Record<string, any> = new Error("Connector fetch requires the absolute resource_link artifact URL.");
    error.code = "release_journey_fetch_url_invalid";
    throw error;
  }
  await fs.rm(outputPath, { force: true });
  const args: any[] = [
    connectorScript,
    "fetch",
    "--artifact", candidateUrl,
    "--out", outputPath,
    "--target", target,
    "--json"
  ];
  const child: any = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout: any = "";
  let stderr: any = "";
  child.stdout.on("data", (chunk?: any) : any => { stdout += chunk; });
  child.stderr.on("data", (chunk?: any) : any => { stderr += chunk; });
  const exitCode: any = await new Promise((resolve?: any, reject?: any) : any => {
    const timer: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("Connector fetch timed out."), { code: "release_journey_fetch_timeout" }));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code?: any) : any => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  let payload: any = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  if (exitCode !== 0 || payload?.ok !== true) {
    const error: Error & Record<string, any> = new Error(`Connector fetch failed (exit ${exitCode}): ${String(payload?.error || stderr).slice(-400)}`);
    error.code = "release_journey_fetch_failed";
    throw error;
  }
  const bytes: any = await fs.readFile(outputPath);
  const sha256: any = createHash("sha256").update(bytes).digest("hex");
  return {
    artifactId: String(payload.artifactId || ""),
    byteLength: Number(payload.byteLength || 0),
    connectorSha256: String(payload.sha256 || ""),
    localSha256: sha256,
    digestVerified: payload.digestVerified === true,
    sha256Matches: sha256 === String(payload.sha256 || ""),
    bytes
  };
}

// Diagnostic: repeat the artifact GET with the connector's own signed
// identity and surface the server's status and public error code. Used only
// to enrich a failed artifact-fetch step; emits no token material.
export async function diagnoseArtifactGet({ artifactUrl, target = "kimi", env = {} }: Record<string, any> = {}) : Promise<any> {
  const previous: Record<string, any> = {};
  for (const [key, value] of (Object.entries(env) as [string, any][])) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const { authHeaders } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts");
    const { processIdentityHeaders } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/process-identity-request.ts");
    const { resolveProxyCredentials } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts");
    const { target: resolvedTarget, token, identity } = await resolveProxyCredentials({ target });
    const response: any = await fetch(artifactUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...authHeaders(token, resolvedTarget),
        ...processIdentityHeaders({ method: "GET", url: new URL(artifactUrl), body: "", identity })
      }
    });
    let code: any = "";
    try {
      code = String((await response.json())?.code || "");
    } catch {
      code = "";
    }
    return { status: response.status, code };
  } catch (error: any) {
    return { status: 0, code: String(error?.code || error?.message || "diagnostic_failed").slice(0, 120) };
  } finally {
    for (const [key, value] of (Object.entries(previous) as [string, any][])) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
