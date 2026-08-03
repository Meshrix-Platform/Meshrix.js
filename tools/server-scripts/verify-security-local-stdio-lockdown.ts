import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  CLIENT_FINGERPRINT_VERSION,
  createProcessIdentityRequestHeaders,
  generateProcessIdentityClientKeyPair
} from "../../packages/foundation/src/security/process-identity/index.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SECURITY_DESIGN_PATH: any = "docs/functionality/SECURITY-AUTHORIZATION.md";

const originalCapabilityKernelEnv: Record<string, any> = {
  MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER,
  MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER: process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER,
  MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER: process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER,
  MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER: process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER
};

function useIsolatedCapabilityKernelForVerifier() : any {
  process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER = "local-file";
  process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER = "local-file";
  process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER = "local-file";
}

function restoreCapabilityKernelEnv() : any {
  for (const [key, value] of (Object.entries(originalCapabilityKernelEnv) as [string, any][])) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function mcpRequest(method?: any, params: Record<string, any> = {}, id: any = 1) : any {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
}

function apiKeyHeaders(token?: any) : any {
  return {
    "Content-Type": "application/json",
    "X-Meshrix-Api-Key": token,
    "X-Meshrix-MCP-Target": "codex"
  };
}

function createVerifierClientIdentity(target: any = "codex") : any {
  const keyPair: any = generateProcessIdentityClientKeyPair();
  const installationId: any = "verify-security-local-process-lockdown-install";
  const clientFingerprint: Record<string, any> = {
    fingerprintId: "verify-security-local-process-lockdown-fp",
    machineInstanceId: "verify-security-local-process-lockdown-machine",
    appInstanceId: "verify-security-local-process-lockdown-app",
    runtimeInstanceId: "verify-security-local-process-lockdown-runtime"
  };
  clientFingerprint.fingerprintHash = `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.from([
      CLIENT_FINGERPRINT_VERSION,
      clientFingerprint.fingerprintId,
      clientFingerprint.machineInstanceId,
      clientFingerprint.appInstanceId,
      clientFingerprint.runtimeInstanceId
    ].join("\n"), "utf8"))
    .digest("base64url")}`;
  const defaultIdentityHash: any = `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.from([
      "v0.0.1:process-identity:mcp-default-identity-1",
      target,
      installationId,
      keyPair.publicKeyHash,
      clientFingerprint.fingerprintHash
    ].join("\n"), "utf8"))
    .digest("base64url")}`;
  return {
    keyPair,
    request: {
      clientId: target,
      installationId,
      processPublicKeyPem: keyPair.publicKeyPem,
      clientFingerprint,
      defaultIdentityHash
    }
  };
}

function signedApiKeyHeaders({ token, privateKeyPem, clientIdentityPackage, body, url, nonce }: Record<string, any>) : any {
  return {
    ...apiKeyHeaders(token),
    ...createProcessIdentityRequestHeaders({
      privateKeyPem,
      method: "POST",
      url,
      body,
      clientIdentityPackage,
      nonce
    })
  };
}

async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function assertNoPublicLocalStdioExposure(value?: any, label?: any) : any {
  const text: any = typeof value === "string" ? value : JSON.stringify(value);
  const processDescriptorPaths: any[] = [];
  const visit: any = (entry?: any, pathParts: any = []) : any => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item?: any, index?: any) : any => visit(item, [...pathParts, String(index)]));
      return;
    }
    const pathLabel: any = pathParts.join(".") || "$";
    if (String(entry.transport || entry.type || "").toLowerCase() === "stdio" || entry.stdioContract) {
      processDescriptorPaths.push(pathLabel);
    }
    if (entry.executable || (entry.command && typeof entry.command === "object")) {
      processDescriptorPaths.push(pathLabel);
    }
    if (typeof entry.command === "string" && (entry.args || entry.cwd || entry.env)) {
      processDescriptorPaths.push(pathLabel);
    }
    for (const [key, item] of (Object.entries(entry) as [string, any][])) {
      visit(item, [...pathParts, key]);
    }
  };
  visit(value);
  const stdioMatch: any = /\bstdio\b/i.exec(text);
  assert.equal(
    Boolean(stdioMatch),
    false,
    `${label} must not expose local stdio transport${stdioMatch ? `: ${text.slice(Math.max(0, stdioMatch.index - 120), stdioMatch.index + 120)}` : ""}`
  );
  assert.equal(
    processDescriptorPaths.length > 0,
    false,
    `${label} must not expose local process launch descriptors: ${processDescriptorPaths.join(", ")}`
  );
}

async function assertSecurityDesignSeparation() : Promise<any> {
  const packageManifest: any = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    packageManifest.scripts["server:verify:security-hardening"],
    "node tools/server-scripts/verify-security-hardening.ts",
    "Security hardening must run through the explicit verifier script"
  );
  await fs.access(path.join(repoRoot, SECURITY_DESIGN_PATH));
  const docsReadme: any = await fs.readFile(path.join(repoRoot, "docs/README.md"), "utf8");
  assert.match(docsReadme, /docs\/functionality\/SECURITY-AUTHORIZATION\.md/, "Docs index must expose the security and authorization functionality document");

  const securityReadme: any = await fs.readFile(path.join(repoRoot, "docs/functionality/SECURITY-AUTHORIZATION.md"), "utf8");
  assert.match(
    securityReadme,
    /verify-security-local-stdio-lockdown\.ts[\s\S]*local-stdio-interface-lockdown/,
    "Security README must record the dedicated verifier and production readiness gate id"
  );

  const securityDesign: any = await fs.readFile(path.join(repoRoot, SECURITY_DESIGN_PATH), "utf8");
  assert.match(
    securityDesign,
    /verify-security-local-stdio-lockdown\.ts[\s\S]*local-stdio-interface-lockdown/,
    "Security design must record the dedicated verifier and production readiness gate id"
  );

  const productionReadinessGate: any = await fs.readFile(path.join(repoRoot, "tools/server-scripts/production-readiness-gate.ts"), "utf8");
  assert.match(
    productionReadinessGate,
    /id:\s*"local-stdio-interface-lockdown"[\s\S]*owner:\s*"security-boundary"[\s\S]*verify-security-local-stdio-lockdown\.ts/,
    "Production readiness must keep local stdio lockdown as a dedicated security gate"
  );

}

async function assertSecurityGateSeparation() : Promise<any> {
  const mcpReleaseVerifier: any = await fs.readFile(path.join(repoRoot, "tools/server-scripts/verify-mcp-release-target-scope.ts"), "utf8");

  assert.doesNotMatch(mcpReleaseVerifier, /assertNoPublicLocalStdioExposure|must not expose local stdio transport/);
}
async function assertMcpPublicPayloadLockdown() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-security-local-stdio-mcp-"));
  useIsolatedCapabilityKernelForVerifier();
  const server: any = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal"
    }
  });
  await installAuthenticatedFetch(server);
  try {
    const discovery: any = await fetchJson(`${server.url}/api/mcp/discovery`);
    assert.equal(discovery.status, 200);
    assertNoPublicLocalStdioExposure(discovery.payload, "MCP discovery payload");

    const initialize: any = await fetchJson(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpRequest("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "verify-security-local-process-lockdown", version: "1" }
      }, 1))
    });
    assert.equal(initialize.status, 200);
    assertNoPublicLocalStdioExposure(initialize.payload.result, "MCP initialize result");

    const verifierIdentity: any = createVerifierClientIdentity("codex");
    const apiKey: any = await issueVerifierMcpApiKey({
      server,
      access: {
        targets: ["codex"],
        label: "verify-security-local-process-lockdown",
        connectorVersion: "security",
        processIdentity: verifierIdentity.request
      }
    });
    assert.ok(apiKey.apiKey);

    const mcpUrl: any = new URL("/mcp", server.url);
    const toolsListBody: any = JSON.stringify(mcpRequest("tools/list", {}, 2));
    const toolsList: any = await fetchJson(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meshrix-Api-Key": apiKey.apiKey, "X-Meshrix-MCP-Target": "codex" },
      body: toolsListBody
    });
    assert.equal(toolsList.status, 200);
    assertNoPublicLocalStdioExposure(toolsList.payload.result, "MCP tools/list result");

    const capabilitiesBody: any = JSON.stringify(mcpRequest("tools/call", {
      name: "meshrix.discovery",
      arguments: {
        apiVersion: "v0.0.1:mcp:interface-1",
        operation: "meshrix.capabilities.list"
      }
    }, 3));
    const capabilities: any = await fetchJson(`${server.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meshrix-Api-Key": apiKey.apiKey, "X-Meshrix-MCP-Target": "codex" },
      body: capabilitiesBody
    });
    assert.equal(capabilities.status, 200);
    assertNoPublicLocalStdioExposure(capabilities.payload.result, "MCP capabilities result");
  } finally {
    await server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    restoreCapabilityKernelEnv();
  }
}

await assertSecurityDesignSeparation();
await assertSecurityGateSeparation();
await assertMcpPublicPayloadLockdown();

console.log("security local stdio lockdown verification passed");
