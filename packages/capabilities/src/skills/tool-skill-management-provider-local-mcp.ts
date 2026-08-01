import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

import {
  clientIpFromRequest,
  isLocalHttpHost,
  isLocalHttpOrigin,
  isLoopbackAddress,
  originHost
} from "@meshrix/foundation/security/trusted-client-ip";

import {
  compactText,
  grantMetadata,
  normalizeGrantTargets,
  normalizeGrantValues,
  normalizedGrantTargetKeys,
  normalizedTargetKey
} from "./tool-skill-management-provider-grant-utils.ts";

const LOCAL_GRANT_MCP_CONNECTOR_PACKAGE: any = "meshrix-mcp-connector";
const LOCAL_GRANT_BOOTSTRAP_SCRIPT: any = "meshrix-mcp-install.sh";
const LOCAL_GRANT_BOOTSTRAP_SCRIPT_ZH_CN: any = "meshrix-mcp-install.zh-CN.sh";
export const LOCAL_GRANT_PRIORITY_TARGETS: readonly any[] = Object.freeze(["claude-code", "codex", "openclaw"]);
const LOCAL_GRANT_READ_TOOLSETS: readonly any[] = Object.freeze([
  "meshrix.runtime.read",
  "meshrix.storage.read",
  "meshrix.jobs.read",
  "meshrix.gateway.read",
  "meshrix.agent.workspace.read",
  "meshrix.result.export"
]);

const LOCAL_GRANT_TARGET_MATCH: Readonly<Record<string, any>> = Object.freeze({
  openclaw: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.openclaw"
  },
  "claude-code": {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.claude-code"
  },
  codex: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.codex"
  },
  antigravity: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.antigravity"
  },
  opencode: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.opencode"
  },
  pi: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.pi"
  },
  copilot: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.copilot"
  },
  "kilo-code": {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.kilo-code"
  },
  cursor: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.cursor"
  },
  hermes: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.hermes"
  },
  kimi: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "meshrix.mcp.kimi"
  }
});

const LOCAL_GRANT_RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export const LOCAL_MCP_AUTHORIZATION_REQUEST_TTL_MS: any = 10 * 60 * 1000;
export const LOCAL_MCP_AUTHORIZATION_REPLAY_TTL_MS: any = 2 * 60 * 1000;
export const LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES: any = 64 * 1024;

const LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION: any = 1;
const LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT: any = "meshrix-local-mcp-authorization-replay";
const LOCAL_MCP_PROCESS_IDENTITY_FIELDS: any = new Set<any>([
  "clientId",
  "installationId",
  "processKeyId",
  "processPublicKeyPem",
  "processPublicKeySpkiBase64",
  "clientFingerprint",
  "defaultIdentityHash",
  "nonce"
]);
const LOCAL_MCP_PROCESS_FINGERPRINT_FIELDS: any = new Set<any>([
  "fingerprintId",
  "machineInstanceId",
  "appInstanceId",
  "runtimeInstanceId",
  "fingerprintHash"
]);

function boundedIdentityText(value?: any, field?: any, maxBytes?: any) : any {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw Object.assign(new Error(`MCP process identity field '${field}' must be a string.`), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
  const normalized: any = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw Object.assign(new Error(`MCP process identity field '${field}' is too large.`), {
      reasonCode: "process_identity_field_too_large"
    });
  }
  return normalized;
}

function rejectUnknownIdentityFields(source?: any, allowedFields?: any, path?: any) : any {
  const unknown: any = Object.keys(source).filter((field?: any) : any => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`MCP process identity contains unsupported ${path} fields.`), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
}

export function normalizeLocalMcpProcessIdentityRequest(input: Record<string, any> = {}) : any {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("MCP process identity must be an object."), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
  rejectUnknownIdentityFields(input, LOCAL_MCP_PROCESS_IDENTITY_FIELDS, "root");
  const fingerprintSource: any = input.clientFingerprint === undefined
    ? null
    : input.clientFingerprint;
  if (
    fingerprintSource !== null &&
    (!fingerprintSource || typeof fingerprintSource !== "object" || Array.isArray(fingerprintSource))
  ) {
    throw Object.assign(new Error("MCP process identity clientFingerprint must be an object."), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
  if (fingerprintSource) {
    rejectUnknownIdentityFields(
      fingerprintSource,
      LOCAL_MCP_PROCESS_FINGERPRINT_FIELDS,
      "clientFingerprint"
    );
  }
  const clientFingerprint: any = fingerprintSource
    ? Object.fromEntries([
        ["fingerprintId", boundedIdentityText(fingerprintSource.fingerprintId, "clientFingerprint.fingerprintId", 256)],
        ["machineInstanceId", boundedIdentityText(fingerprintSource.machineInstanceId, "clientFingerprint.machineInstanceId", 256)],
        ["appInstanceId", boundedIdentityText(fingerprintSource.appInstanceId, "clientFingerprint.appInstanceId", 256)],
        ["runtimeInstanceId", boundedIdentityText(fingerprintSource.runtimeInstanceId, "clientFingerprint.runtimeInstanceId", 256)],
        ["fingerprintHash", boundedIdentityText(fingerprintSource.fingerprintHash, "clientFingerprint.fingerprintHash", 256)]
      ].filter(([, value]: any[]) : any => value))
    : null;
  return Object.fromEntries([
    ["clientId", boundedIdentityText(input.clientId, "clientId", 128)],
    ["installationId", boundedIdentityText(input.installationId, "installationId", 128)],
    ["processKeyId", boundedIdentityText(input.processKeyId, "processKeyId", 128)],
    ["processPublicKeyPem", boundedIdentityText(input.processPublicKeyPem, "processPublicKeyPem", 8 * 1024)],
    ["processPublicKeySpkiBase64", boundedIdentityText(input.processPublicKeySpkiBase64, "processPublicKeySpkiBase64", 8 * 1024)],
    ["clientFingerprint", clientFingerprint],
    ["defaultIdentityHash", boundedIdentityText(input.defaultIdentityHash, "defaultIdentityHash", 256)],
    ["nonce", boundedIdentityText(input.nonce, "nonce", 256)]
  ].filter(([, value]: any[]) : any => value && (typeof value !== "object" || Object.keys(value).length > 0)));
}

function localMcpAuthorizationReplayKey(claimToken?: any, requestId?: any) : any {
  return createHash("sha256")
    .update(LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(String(requestId || ""), "utf8")
    .update("\0", "utf8")
    .update(String(claimToken || ""), "utf8")
    .digest();
}

function localMcpAuthorizationReplayAad(requestId?: any) : any {
  return Buffer.from(
    `${LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT}\0${String(requestId || "")}`,
    "utf8"
  );
}

export function sealLocalMcpAuthorizationReplay({ claimToken = "", requestId = "", response = null }: Record<string, any> = {}) : any {
  const nonce: any = randomBytes(12);
  const cipher: any = createCipheriv(
    "aes-256-gcm",
    localMcpAuthorizationReplayKey(claimToken, requestId),
    nonce
  );
  cipher.setAAD(localMcpAuthorizationReplayAad(requestId));
  const plaintext: any = Buffer.from(JSON.stringify(response), "utf8");
  const ciphertext: any = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  });
}

export function openLocalMcpAuthorizationReplay({ claimToken = "", requestId = "", envelope = "" }: Record<string, any> = {}) : any {
  const parsed: any = JSON.parse(String(envelope || ""));
  if (
    parsed?.version !== LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("MCP authorization replay envelope is invalid.");
  }
  const nonce: any = Buffer.from(parsed.nonce, "base64url");
  const tag: any = Buffer.from(parsed.tag, "base64url");
  const ciphertext: any = Buffer.from(parsed.ciphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("MCP authorization replay envelope is invalid.");
  }
  const decipher: any = createDecipheriv(
    "aes-256-gcm",
    localMcpAuthorizationReplayKey(claimToken, requestId),
    nonce
  );
  decipher.setAAD(localMcpAuthorizationReplayAad(requestId));
  decipher.setAuthTag(tag);
  const plaintext: any = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function normalizeApiKeyHeader(request?: any) : any {
	const headers: any = request?.headers || {};
	if (!headers.authorization && !headers["x-meshrix-tool-token"] && headers["x-meshrix-api-key"]) {
		headers["x-meshrix-tool-token"] = String(headers["x-meshrix-api-key"] || "").trim();
	}
}

export function parseRequestBody(requestBody?: any) : any {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function isSameOriginBrowserRequest(request?: any) : any {
  const origin: any = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  if (origin === "null" || !isLocalHttpOrigin(origin)) {
    return false;
  }
  const host: any = String(request?.headers?.host || "").trim();
  if (!isLocalHttpHost(host)) {
    return false;
  }
  return originHost(origin) === host.toLowerCase();
}

export function hasMcpForwardingMetadata(request?: any) : any {
  const headers: any = request?.headers || {};
  return (Object.entries(headers) as [string, any][]).some(([name, value]: any[]) : any => {
    const normalizedName: any = String(name || "").trim().toLowerCase();
    return (normalizedName === "forwarded" ||
      normalizedName === "x-real-ip" ||
      normalizedName.startsWith("x-forwarded-")) &&
      Boolean(String(value || "").trim());
  });
}

function isValidDirectMcpHost(value: any = "") : any {
  const host: any = String(value || "").trim();
  if (!host || host.length > 512 || /[\s/@\\?#]/u.test(host)) {
    return false;
  }
  try {
    const parsed: any = new URL(`http://${host}`);
    return Boolean(parsed.hostname) && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isSameOriginDirectMcpRequest(request?: any) : any {
  const origin: any = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  try {
    const parsed: any = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host.toLowerCase() === String(request?.headers?.host || "").trim().toLowerCase();
  } catch {
    return false;
  }
}

export function isDirectMcpClientRequest(request?: any) : any {
  const host: any = String(request?.headers?.host || "").trim();
  return !hasMcpForwardingMetadata(request) &&
    Boolean(clientIpFromRequest(request)) &&
    isValidDirectMcpHost(host) &&
    isSameOriginDirectMcpRequest(request);
}

export function isLocalMcpPairingRequest(request?: any) : any {
  const host: any = String(request?.headers?.host || "").trim();
  return !hasMcpForwardingMetadata(request) &&
    isLoopbackAddress(clientIpFromRequest(request)) &&
    isLocalHttpHost(host) &&
    isSameOriginBrowserRequest(request);
}

export function localMcpGrantTargets(grant?: any) : any {
  const metadata: any = grantMetadata(grant);
  return [
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ].filter((target?: any, index?: any, values?: any) : any => values.indexOf(target) === index);
}

export function isLocalMcpGrant(grant?: any) : any {
  const metadata: any = grantMetadata(grant);
  return (
    String(metadata.issuedBy || "").trim() === "meshrix-mcp-local-pairing" ||
    String(grant?.type || "").trim() === "mcp-client"
  );
}

export function localMcpGrantTargetKeys(grant?: any) : any {
  const metadata: any = grantMetadata(grant);
  return normalizedGrantTargetKeys([
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ]);
}

export function localGrantTargetMatch(targets: any = []) : any {
  const matchedTargets: any[] = [];
  const unmatchedTargets: any[] = [];
  const toolsets: any = new Set<any>();
  let agentProfileId: any = "";
  for (const target of targets) {
    const key: any = normalizedTargetKey(target);
    const profile: any = LOCAL_GRANT_TARGET_MATCH[key] || null;
    if (!profile) {
      unmatchedTargets.push(target);
      continue;
    }
    matchedTargets.push(target);
    if (!agentProfileId) {
      agentProfileId = profile.agentProfileId || "";
    }
    for (const toolset of profile.toolsets || []) {
      toolsets.add(toolset);
    }
  }
  return {
    matched: matchedTargets.length > 0,
    matchedTargets,
    unmatchedTargets,
    toolsets: [...toolsets],
    agentProfileId
  };
}

export function localGrantSupportedTargets() : any {
  return Object.keys(LOCAL_GRANT_TARGET_MATCH);
}

export function localGrantSupportedTargetDetails() : any {
  return (Object.entries(LOCAL_GRANT_TARGET_MATCH) as [string, any][]).map(([target, profile]: any[]) : any => ({
    target,
    agentProfileId: profile.agentProfileId || "",
    toolsets: [...(profile.toolsets || [])],
    maxRisk: "read_only"
  }));
}

export function localGrantMatchedTargetDetails(targets: any = []) : any {
  return targets
    .map((target?: any) : any => {
      const profile: any = LOCAL_GRANT_TARGET_MATCH[normalizedTargetKey(target)] || null;
      return profile
        ? {
            target,
            agentProfileId: profile.agentProfileId || "",
            toolsets: [...(profile.toolsets || [])],
            maxRisk: "read_only"
          }
        : null;
    })
    .filter(Boolean);
}

export function localGrantRequestBaseUrl({ request = null, discoveryState = null }: Record<string, any> = {}) : any {
  const activeServiceUrl: any = String(discoveryState?.activeServiceUrl || "").replace(/\/+$/, "");
  if (activeServiceUrl) {
    return activeServiceUrl;
  }
  const host: any = String(request?.headers?.host || "").trim();
  if (!host) {
    return "";
  }
  const forwardedProto: any = String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol: any = forwardedProto || (request?.socket?.encrypted ? "https" : "http");
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

export function localGrantVmBaseUrl(baseUrl: any = "") : any {
  try {
    const parsed: any = new URL(baseUrl);
    return `${parsed.protocol}//host.orb.internal:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "";
  }
}

export function localGrantShellQuote(value?: any) : any {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

export function localGrantGithubOneLineCommand(scriptName: any = LOCAL_GRANT_BOOTSTRAP_SCRIPT) : any {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(scriptName || ""))) {
    throw new Error("invalid_local_installer_name");
  }
  return `/bin/sh -c 'exec /bin/sh ./${scriptName} "$@"'`;
}

export function localGrantGithubOneLineInstallCommands({ baseUrl = "" }: Record<string, any> = {}) : any {
  const urlArgs: any = baseUrl ? ` --url ${localGrantShellQuote(baseUrl)}` : "";
  const command: any = localGrantGithubOneLineCommand();
  const commandZhCN: any = localGrantGithubOneLineCommand(LOCAL_GRANT_BOOTSTRAP_SCRIPT_ZH_CN);
  const priorityTargets: any = LOCAL_GRANT_PRIORITY_TARGETS.join(",");
  const build: any = (oneLineCommand?: any) : any => ({
    installCommand: urlArgs ? `${oneLineCommand} --${urlArgs}` : oneLineCommand,
    clientInstallJsonCommand: `${oneLineCommand} -- --target <client>${urlArgs} --json`,
    autoInstallCommand: `${oneLineCommand} -- --target auto${urlArgs} --json`,
    priorityInstallCommand: `${oneLineCommand} -- --target ${priorityTargets}${urlArgs} --json`
  });
  const english: any = build(command);
  const zhCN: any = build(commandZhCN);
  return {
    githubOneLineCommand: command,
    githubOneLineInstallCommand: english.installCommand,
    githubOneLineClientInstallJsonCommand: english.clientInstallJsonCommand,
    githubOneLineAutoInstallCommand: english.autoInstallCommand,
    githubOneLinePriorityInstallCommand: english.priorityInstallCommand,
    githubOneLineCommandZhCN: commandZhCN,
    githubOneLineInstallCommandZhCN: zhCN.installCommand,
    githubOneLineClientInstallJsonCommandZhCN: zhCN.clientInstallJsonCommand,
    githubOneLineAutoInstallCommandZhCN: zhCN.autoInstallCommand,
    githubOneLinePriorityInstallCommandZhCN: zhCN.priorityInstallCommand
  };
}

export function localGrantConnectorMetadata({ request = null, discoveryState = null }: Record<string, any> = {}) : any {
  const baseUrl: any = localGrantRequestBaseUrl({ request, discoveryState });
  const urlArgs: any = baseUrl ? ` --url ${localGrantShellQuote(baseUrl)}` : "";
  const oneLineCommands: any = localGrantGithubOneLineInstallCommands({ baseUrl });
  return {
    packageName: LOCAL_GRANT_MCP_CONNECTOR_PACKAGE,
    priorityTargets: [...LOCAL_GRANT_PRIORITY_TARGETS],
    ...oneLineCommands,
    oneCommandInstall: oneLineCommands.githubOneLineInstallCommand,
    oneCommandInstallZhCN: oneLineCommands.githubOneLineInstallCommandZhCN,
    oneCommandClientInstallJson: oneLineCommands.githubOneLineClientInstallJsonCommand,
    oneCommandClientInstallJsonZhCN: oneLineCommands.githubOneLineClientInstallJsonCommandZhCN,
    oneCommandAutoInstall: oneLineCommands.githubOneLineAutoInstallCommand,
    oneCommandAutoInstallZhCN: oneLineCommands.githubOneLineAutoInstallCommandZhCN,
    oneCommandPriorityInstall: oneLineCommands.githubOneLinePriorityInstallCommand,
    oneCommandPriorityInstallZhCN: oneLineCommands.githubOneLinePriorityInstallCommandZhCN,
    discoverCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest discover-local${urlArgs} --json`,
    scanCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest scan${urlArgs} --json`,
    doctorCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest doctor${urlArgs} --json`,
    clientInstallCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest install --target <client>${urlArgs}`,
    clientInstallJsonCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest install --target <client>${urlArgs} --json`,
    autoInstallCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest install --target auto${urlArgs} --json`,
    priorityInstallCommand: `npx ${LOCAL_GRANT_MCP_CONNECTOR_PACKAGE}@latest install --target ${LOCAL_GRANT_PRIORITY_TARGETS.join(",")}${urlArgs} --json`
  };
}

export function localGrantSharedHubContract({ request = null, discoveryState = null }: Record<string, any> = {}) : any {
  const baseUrl: any = localGrantRequestBaseUrl({ request, discoveryState });
  const vmBaseUrl: any = localGrantVmBaseUrl(baseUrl);
  return {
    canonicalMcpUrl: baseUrl ? `${baseUrl}/mcp` : "",
    vmMcpUrl: vmBaseUrl ? `${vmBaseUrl}/mcp` : "",
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

export function localGrantRiskRank(risk: any = "read_only") : any {
  return LOCAL_GRANT_RISK_RANK[String(risk || "read_only")] ?? 0;
}

export function grantVisibleRisk(grant: any = null) : any {
  const metadata: any = grantMetadata(grant);
  return String(metadata.maxRisk || grant?.maxRisk || "read_only").trim() || "read_only";
}

export function grantCanSeeTool(tool?: any, grant: any = null) : any {
  if (!tool || tool.status !== "active" || !grant) {
    return false;
  }
  const deniedTools: any = new Set<any>(normalizeGrantValues(grant.toolDeny || [], 256));
  if (deniedTools.has(tool.id)) {
    return false;
  }
  const allowedTools: any = new Set<any>(normalizeGrantValues(grant.toolAllow || [], 256));
  if (allowedTools.size > 0 && !allowedTools.has(tool.id)) {
    return false;
  }
  const grantScopes: any = new Set<any>(normalizeGrantValues(grant.scopes || [], 512));
  const missingScopes: any = (tool.requiredScopes || []).filter((scope?: any) : any => !grantScopes.has(scope));
  if (missingScopes.length > 0) {
    return false;
  }
  const grantToolsets: any = new Set<any>(normalizeGrantValues(grant.toolsets || [], 256));
  if (grantToolsets.size > 0 && !(tool.toolsets || []).some((toolset?: any) : any => grantToolsets.has(toolset))) {
    return false;
  }
  if (localGrantRiskRank(tool.risk || "read_only") > localGrantRiskRank(grantVisibleRisk(grant))) {
    return false;
  }
  const dynamicCapability: any = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    ? tool.dynamicCapability
    : null;
  if (!dynamicCapability) return true;
  const metadata: any = grantMetadata(grant);
  const dynamicCapabilities: any = new Set<any>([
    ...normalizeGrantValues(grant.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(grant.upstreamCapabilities || [], 512),
    ...normalizeGrantValues(metadata.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(metadata.upstreamCapabilities || [], 512)
  ]);
  const capabilityId: any = String(dynamicCapability.capabilityId || "").trim();
  if (!capabilityId || !dynamicCapabilities.has(capabilityId)) return false;
  const allowedServiceIds: any = new Set<any>([
    ...normalizeGrantValues(grant.allowedServiceIds || [], 512),
    ...normalizeGrantValues(metadata.allowedServiceIds || [], 512)
  ]);
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(String(dynamicCapability.serviceId || ""))) {
    return false;
  }
  const allowedSecretBindings: any = new Set<any>([
    ...normalizeGrantValues(grant.allowedSecretBindings || [], 512),
    ...normalizeGrantValues(metadata.allowedSecretBindings || [], 512)
  ]);
  return normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128).every((bindingId?: any) : any =>
    allowedSecretBindings.has(bindingId) || dynamicCapabilities.has(`${capabilityId}:${bindingId}`)
  );
}

export function hasSafetyConfirm(request: any = null) : any {
  const value: any = String(
    request?.headers?.["x-meshrix-safety-confirm"] ||
      request?.headers?.["x-meshrix-confirm"] ||
      ""
  ).toLowerCase();
  return ["1", "true", "yes"].includes(value);
}

export function requestedLocalGrantMaxRisk(body: Record<string, any> = {}, resolved: Record<string, any> = {}) : any {
  const requested: any = String(body.maxRisk || body.max_risk || "").trim();
  if (LOCAL_GRANT_RISK_RANK[requested] !== undefined) {
    return requested;
  }
  const grantMode: any = String(body.grantMode || body.grant_mode || body.mode || "").trim();
  if (["maintain", "admin", "repair"].includes(grantMode)) {
    return "repair_write";
  }
  if (["write", "safe_write"].includes(grantMode)) {
    return "safe_write";
  }
  if (localGrantRiskRank(resolved.maxRisk) >= localGrantRiskRank("repair_write")) {
    return "safe_write";
  }
  return resolved.maxRisk || "read_only";
}

export function denyLocalGrant(status?: any, code?: any, message?: any, details: Record<string, any> = {}) : any {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        details
      }
    }
  };
}

export function hashLocalMcpAuthorizationClaim(value: any = "") : any {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function isLocalMcpAuthorizationClaimHash(value: any = "") : any {
  return /^[a-f0-9]{64}$/u.test(String(value || "").trim());
}

export function localMcpAuthorizationVerificationCode(claimTokenHash: any = "") : any {
  const normalized: any = String(claimTokenHash || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(normalized)) {
    return "";
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

export function localMcpProcessKeyFingerprint(processIdentityRequest: Record<string, any> = {}) : any {
  const publicKey: any = String(
    processIdentityRequest.processPublicKeyPem ||
      processIdentityRequest.processPublicKeySpkiBase64 ||
      processIdentityRequest.publicKeyPem ||
      processIdentityRequest.publicKeySpkiBase64 ||
      ""
  ).trim();
  return publicKey ? `sha256:${createHash("sha256").update(publicKey, "utf8").digest("hex")}` : "";
}

export async function authorizeLocalGrantIssuance({
  request,
  url,
  securityPermissions = null,
  resolved,
  requestedMaxRisk,
  matchedLocalTarget = false
}: Record<string, any>) : Promise<any> {
  const resolvedRisk: any = String(resolved.maxRisk || "read_only");
  if (!securityPermissions || typeof securityPermissions.authorizeOperation !== "function") {
    return denyLocalGrant(
      503,
      "console_authorization_unavailable",
      "MCP local grant issuance requires console authorization.",
      { maxRisk: resolvedRisk, matchedLocalTarget: matchedLocalTarget === true }
    );
  }
  const authorization: any = await securityPermissions.authorizeOperation({
    request,
    method: "POST",
    url,
    operation: {
      id: "mcp.local_grant",
      requiredScopes: ["runtime:admin"],
      skipCsrf: false
    }
  });
  if (!authorization.ok) {
    return denyLocalGrant(
      authorization.status || 403,
      authorization.status === 401 ? "console_unauthenticated" : "console_forbidden",
      authorization.error || "MCP local grant issuance requires an authenticated console session.",
      { maxRisk: resolvedRisk }
    );
  }
  if (localGrantRiskRank(resolvedRisk) <= localGrantRiskRank("read_only")) {
    return null;
  }
  if (!hasSafetyConfirm(request)) {
    return denyLocalGrant(
      403,
      "confirmation_required",
      "Write-capable MCP local grants require x-meshrix-safety-confirm: true.",
      { maxRisk: resolvedRisk }
    );
  }
  if (
    localGrantRiskRank(resolvedRisk) >= localGrantRiskRank("repair_write") &&
    localGrantRiskRank(requestedMaxRisk) < localGrantRiskRank("repair_write")
  ) {
    return denyLocalGrant(
      403,
      "repair_grant_mode_required",
      "Repair-capable MCP local grants require grantMode=maintain or maxRisk=repair_write.",
      { maxRisk: resolvedRisk }
    );
  }
  return null;
}

export function slugText(value?: any, fallback: any = "target") : any {
  const normalized: any = compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function mcpGrantConnectionState(grant?: any, { offlineAfterSeconds = 0 }: Record<string, any> = {}) : any {
  if (compactText(grant?.revokedAt)) {
    return { state: "revoked", label: "已撤销", alignmentState: "offline" };
  }
  if (grant?.enabled === false) {
    return { state: "disabled", label: "停用", alignmentState: "offline" };
  }

  const lastUsedAt: any = compactText(grant?.lastUsedAt);
  if (!lastUsedAt) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }

  const ageSeconds: any = Math.max(0, Math.floor((Date.now() - new Date(lastUsedAt).getTime()) / 1000));
  if (!Number.isFinite(ageSeconds)) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }
  const offlineThreshold: any = Number(offlineAfterSeconds || 0);
  if (offlineThreshold <= 0) {
    return { state: "unknown", label: "未配置离线阈值", alignmentState: "unknown" };
  }
  if (ageSeconds > offlineThreshold) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }

  return { state: "connected", label: "在线", alignmentState: "unknown" };
}

export function isMcpGrantTargetUninstalled(grant?: any, target?: any) : any {
  const metadata: any = grantMetadata(grant);
  const uninstalledTargets: any = normalizedGrantTargetKeys(metadata.uninstalledTargets);
  if (uninstalledTargets.includes(normalizedTargetKey(target))) {
    return true;
  }
  return metadata.currentDeviceVisible === false && Boolean(compactText(metadata.uninstalledAt));
}

export function mcpGrantClientRows(grant?: any, { offlineAfterSeconds = 0 }: Record<string, any> = {}) : any {
  const connection: any = mcpGrantConnectionState(grant, { offlineAfterSeconds });
  const metadata: any = grantMetadata(grant);
  const targets: any = localMcpGrantTargets(grant).length > 0
    ? localMcpGrantTargets(grant)
    : [compactText(grant?.label).replace(/\s*\(MCP Client\)\s*$/i, "") || compactText(grant?.id) || "MCP 插件"];
  return targets
    .filter((target?: any) : any => !isMcpGrantTargetUninstalled(grant, target))
    .map((target?: any, index?: any) : any => {
      const targetKey: any = targets.length > 1 ? `${slugText(target)}-${index + 1}` : slugText(target);
      const lastSeenAt: any = compactText(grant.lastUsedAt || grant.updatedAt || grant.createdAt);
      return {
        clientId: `mcp:${grant.id}:${targetKey}`,
        clientLabel: target || grant.label || grant.id,
        appVersion: compactText(metadata.connectorVersion),
        platform: "MCP 插件",
        hostname: target || "",
        bootstrapUrl: "",
        currentServiceUrl: "",
        desiredServiceUrl: "",
        currentJobServiceUrl: "",
        configVersion: "",
        alignmentState: connection.alignmentState,
        connectionKind: "mcp-plugin",
        connectionMethod: "MCP 服务",
        connectionState: connection.state,
        connectionStatusLabel: connection.label,
        connectionDetail: "Operation Permission 授权",
        supportsAlignment: false,
        sourceGrantId: grant.id,
        busy: false,
        lastJobId: "",
        lastError: "",
        firstSeenAt: compactText(grant.createdAt),
        lastSeenAt,
        lastSeenServerId: compactText(metadata.serverId)
      };
    });
}
