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

import { createMcpProxyStdioClient } from "./mcp-proxy-stdio-client.mjs";

// Client-side mirror of packages/agents/src/upstream-gateway/support.mjs
// safePublicToolSegment; the server remains the source of truth and the
// tools/list assertion below fails closed on any drift.
export function safePublicToolSegment(value = "") {
  return String(value)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "service";
}

function textPayloadOf(result) {
  const content = result?.result?.content || result?.content || [];
  const text = content.find((item) => item?.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function contentItemsOf(result) {
  return result?.result?.content || result?.content || [];
}

export async function runMcpJourney({
  connectorScript,
  target = "kimi",
  baseUrl,
  serviceId,
  fixtureBytes,
  fixtureFileName,
  env = {},
  workspaceTitle = "release-journey-gate",
  redact = (value) => value,
  callTimeoutMs = 120000
} = {}) {
  if (!Buffer.isBuffer(fixtureBytes) || fixtureBytes.length === 0) {
    throw new TypeError("runMcpJourney requires the fixture bytes.");
  }
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const fileName = String(fixtureFileName || "fixture.txt");
  const relativePath = `uploads/${fileName}`;
  const convertToolName = `upstream.${safePublicToolSegment(serviceId)}.convert`;
  const receipt = { fixture: { name: fileName, byteLength: fixtureBytes.length, sha256: fixtureSha256 } };

  const client = createMcpProxyStdioClient({
    connectorScript,
    target,
    baseUrl,
    env,
    timeoutMs: callTimeoutMs,
    redactText: redact
  });
  try {
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "release-journey-gate", version: "0.0.1" }
    });
    receipt.initialize = {
      serverName: String(initialize?.result?.serverInfo?.name || ""),
      protocolVersion: String(initialize?.result?.protocolVersion || "")
    };
    await client.notify("notifications/initialized", {});

    const toolsList = await client.request("tools/list", {});
    const toolNames = (toolsList?.result?.tools || []).map((tool) => tool.name);
    receipt.tools = toolNames;
    for (const expected of ["meshrix.discovery", "meshrix.gateway", convertToolName]) {
      if (!toolNames.includes(expected)) {
        const error = new Error(`Expected MCP tool ${expected} is not visible; saw ${toolNames.join(", ")}.`);
        error.code = "release_journey_tool_missing";
        throw error;
      }
    }

    const created = await client.request("tools/call", {
      name: "meshrix.discovery",
      arguments: {
        operation: "meshrix.agentWorkspace.create",
        input: {
          title: workspaceTitle,
          objective: "Release journey gate: TXT to PDF through the upstream format-convert service"
        }
      }
    });
    const workspace = textPayloadOf(created)?.payload?.workspace || {};
    const workspaceId = String(workspace.workspaceId || "");
    if (!workspaceId) {
      const error = new Error("agentWorkspace.create did not return the internal workspaceId required for workspace: references.");
      error.code = "release_journey_workspace_id_missing";
      throw error;
    }
    receipt.workspace = { workspaceId, workspaceRef: String(workspace.workspaceRef || "") };

    const uploaded = await client.request("tools/call", {
      name: "meshrix.discovery",
      arguments: {
        operation: "meshrix.agentWorkspace.file.upload",
        input: {
          workspaceId,
          path: relativePath,
          fileName,
          contentBase64: fixtureBytes.toString("base64")
        }
      }
    });
    const uploadedFile = textPayloadOf(uploaded)?.payload?.file || {};
    receipt.upload = {
      relativePath: String(uploadedFile.relativePath || relativePath),
      sizeBytes: Number(uploadedFile.sizeBytes || 0),
      contentSha256: String(uploadedFile.contentSha256 || "")
    };
    if (receipt.upload.contentSha256 !== fixtureSha256 || receipt.upload.sizeBytes !== fixtureBytes.length) {
      const error = new Error("Uploaded file digest or size does not match the fixture.");
      error.code = "release_journey_upload_mismatch";
      throw error;
    }

    const jobs = await client.request("tools/call", {
      name: "meshrix.discovery",
      arguments: { operation: "meshrix.jobs.list", input: { limit: 5 } }
    });
    const jobsPayload = textPayloadOf(jobs)?.payload || {};
    receipt.jobs = { count: Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs.length : 0 };

    const reference = `workspace:${workspaceId}:${relativePath}`;
    const converted = await client.request("tools/call", {
      name: convertToolName,
      arguments: { arguments: { file: reference, targetFormat: "pdf" } }
    }, { timeoutMs: Math.max(callTimeoutMs, 180000) });
    const items = contentItemsOf(converted);
    const resourceLink = items.find((item) => item?.type === "resource_link") || null;
    const textItem = items.find((item) => item?.type === "text") || null;
    if (!resourceLink?.uri) {
      const error = new Error("Convert result does not contain a resource_link item.");
      error.code = "release_journey_resource_link_missing";
      throw error;
    }
    if (!textItem?.text) {
      const error = new Error("Convert result does not contain the operator-facing text receipt.");
      error.code = "release_journey_text_receipt_missing";
      throw error;
    }
    const linkUrl = new URL(resourceLink.uri);
    const base = new URL(baseUrl);
    if (linkUrl.origin !== base.origin) {
      const error = new Error("Artifact resource_link origin does not match the advertised server origin.");
      error.code = "release_journey_resource_origin_mismatch";
      throw error;
    }
    if (!/^\/api\/gateway\/v1\/artifacts\/[^/]+$/u.test(linkUrl.pathname)) {
      const error = new Error("Artifact resource_link does not target the gateway artifact route.");
      error.code = "release_journey_resource_route_invalid";
      throw error;
    }
    receipt.convert = {
      tool: convertToolName,
      reference: `workspace:<workspaceId>:${relativePath}`,
      artifactId: decodeURIComponent(linkUrl.pathname.split("/").pop() || ""),
      artifactName: String(resourceLink.name || ""),
      mediaType: String(resourceLink.mimeType || ""),
      size: Number(resourceLink.size || 0),
      contentTypes: items.map((item) => item.type),
      resourceOriginMatchesAdvertised: true,
      artifactUrl: linkUrl.toString()
    };
    return { receipt, artifactUrl: linkUrl.toString(), artifactId: receipt.convert.artifactId };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runConnectorFetch({
  connectorScript,
  target = "kimi",
  artifactUrl,
  outputPath,
  env = {},
  timeoutMs = 120000
} = {}) {
  const candidateUrl = String(artifactUrl || "").trim();
  if (!/^https?:\/\//iu.test(candidateUrl)) {
    const error = new Error("Connector fetch requires the absolute resource_link artifact URL.");
    error.code = "release_journey_fetch_url_invalid";
    throw error;
  }
  await fs.rm(outputPath, { force: true });
  const args = [
    connectorScript,
    "fetch",
    "--artifact", candidateUrl,
    "--out", outputPath,
    "--target", target,
    "--json"
  ];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("Connector fetch timed out."), { code: "release_journey_fetch_timeout" }));
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  let payload = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  if (exitCode !== 0 || payload?.ok !== true) {
    const error = new Error(`Connector fetch failed (exit ${exitCode}): ${String(payload?.error || stderr).slice(-400)}`);
    error.code = "release_journey_fetch_failed";
    throw error;
  }
  const bytes = await fs.readFile(outputPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
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
export async function diagnoseArtifactGet({ artifactUrl, target = "kimi", env = {} } = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const { authHeaders } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.mjs");
    const { processIdentityHeaders } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/process-identity-request.mjs");
    const { resolveProxyCredentials } = await import("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.mjs");
    const { target: resolvedTarget, token, identity } = await resolveProxyCredentials({ target });
    const response = await fetch(artifactUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...authHeaders(token, resolvedTarget),
        ...processIdentityHeaders({ method: "GET", url: new URL(artifactUrl), body: "", identity })
      }
    });
    let code = "";
    try {
      code = String((await response.json())?.code || "");
    } catch {
      code = "";
    }
    return { status: response.status, code };
  } catch (error) {
    return { status: 0, code: String(error?.code || error?.message || "diagnostic_failed").slice(0, 120) };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
