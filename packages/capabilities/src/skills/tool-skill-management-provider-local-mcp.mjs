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
} from "@lico/foundation/security/trusted-client-ip";

import {
  compactText,
  grantMetadata,
  normalizeGrantTargets,
  normalizeGrantValues,
  normalizedGrantTargetKeys,
  normalizedTargetKey
} from "./tool-skill-management-provider-grant-utils.mjs";

const LOCAL_GRANT_MCP_CONNECTOR_PACKAGE = "lico-mcp-connector";
const LOCAL_GRANT_BOOTSTRAP_SCRIPT = "lico-mcp-install.sh";
const LOCAL_GRANT_BOOTSTRAP_SCRIPT_ZH_CN = "lico-mcp-install.zh-CN.sh";
export const LOCAL_GRANT_PRIORITY_TARGETS = Object.freeze(["claude-code", "codex", "openclaw"]);
const LOCAL_GRANT_READ_TOOLSETS = Object.freeze([
  "lico.runtime.read",
  "lico.storage.read",
  "lico.jobs.read",
  "lico.gateway.read",
  "lico.agent.workspace.read",
  "lico.result.export"
]);

const LOCAL_GRANT_TARGET_MATCH = Object.freeze({
  openclaw: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.openclaw"
  },
  "claude-code": {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.claude-code"
  },
  codex: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.codex"
  },
  antigravity: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.antigravity"
  },
  opencode: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.opencode"
  },
  pi: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.pi"
  },
  copilot: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.copilot"
  },
  "kilo-code": {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.kilo-code"
  },
  cursor: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.cursor"
  },
  hermes: {
    toolsets: LOCAL_GRANT_READ_TOOLSETS,
    agentProfileId: "lico.mcp.hermes"
  }
});

const LOCAL_GRANT_RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export const LOCAL_MCP_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const LOCAL_MCP_AUTHORIZATION_REPLAY_TTL_MS = 2 * 60 * 1000;
export const LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES = 64 * 1024;

const LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION = 1;
const LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT = "lico-local-mcp-authorization-replay";
const LOCAL_MCP_PROCESS_IDENTITY_FIELDS = new Set([
  "clientId",
  "installationId",
  "processKeyId",
  "processPublicKeyPem",
  "processPublicKeySpkiBase64",
  "clientFingerprint",
  "defaultIdentityHash",
  "nonce"
]);
const LOCAL_MCP_PROCESS_FINGERPRINT_FIELDS = new Set([
  "fingerprintId",
  "machineInstanceId",
  "appInstanceId",
  "runtimeInstanceId",
  "fingerprintHash"
]);

function boundedIdentityText(value, field, maxBytes) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw Object.assign(new Error(`MCP process identity field '${field}' must be a string.`), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw Object.assign(new Error(`MCP process identity field '${field}' is too large.`), {
      reasonCode: "process_identity_field_too_large"
    });
  }
  return normalized;
}

function rejectUnknownIdentityFields(source, allowedFields, path) {
  const unknown = Object.keys(source).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`MCP process identity contains unsupported ${path} fields.`), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
}

export function normalizeLocalMcpProcessIdentityRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("MCP process identity must be an object."), {
      reasonCode: "process_identity_schema_invalid"
    });
  }
  rejectUnknownIdentityFields(input, LOCAL_MCP_PROCESS_IDENTITY_FIELDS, "root");
  const fingerprintSource = input.clientFingerprint === undefined
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
  const clientFingerprint = fingerprintSource
    ? Object.fromEntries([
        ["fingerprintId", boundedIdentityText(fingerprintSource.fingerprintId, "clientFingerprint.fingerprintId", 256)],
        ["machineInstanceId", boundedIdentityText(fingerprintSource.machineInstanceId, "clientFingerprint.machineInstanceId", 256)],
        ["appInstanceId", boundedIdentityText(fingerprintSource.appInstanceId, "clientFingerprint.appInstanceId", 256)],
        ["runtimeInstanceId", boundedIdentityText(fingerprintSource.runtimeInstanceId, "clientFingerprint.runtimeInstanceId", 256)],
        ["fingerprintHash", boundedIdentityText(fingerprintSource.fingerprintHash, "clientFingerprint.fingerprintHash", 256)]
      ].filter(([, value]) => value))
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
  ].filter(([, value]) => value && (typeof value !== "object" || Object.keys(value).length > 0)));
}

function localMcpAuthorizationReplayKey(claimToken, requestId) {
  return createHash("sha256")
    .update(LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(String(requestId || ""), "utf8")
    .update("\0", "utf8")
    .update(String(claimToken || ""), "utf8")
    .digest();
}

function localMcpAuthorizationReplayAad(requestId) {
  return Buffer.from(
    `${LOCAL_MCP_AUTHORIZATION_REPLAY_CONTEXT}\0${String(requestId || "")}`,
    "utf8"
  );
}

export function sealLocalMcpAuthorizationReplay({ claimToken = "", requestId = "", response = null } = {}) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    localMcpAuthorizationReplayKey(claimToken, requestId),
    nonce
  );
  cipher.setAAD(localMcpAuthorizationReplayAad(requestId));
  const plaintext = Buffer.from(JSON.stringify(response), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  });
}

export function openLocalMcpAuthorizationReplay({ claimToken = "", requestId = "", envelope = "" } = {}) {
  const parsed = JSON.parse(String(envelope || ""));
  if (
    parsed?.version !== LOCAL_MCP_AUTHORIZATION_REPLAY_ENVELOPE_VERSION ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("MCP authorization replay envelope is invalid.");
  }
  const nonce = Buffer.from(parsed.nonce, "base64url");
  const tag = Buffer.from(parsed.tag, "base64url");
  const ciphertext = Buffer.from(parsed.ciphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("MCP authorization replay envelope is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    localMcpAuthorizationReplayKey(claimToken, requestId),
    nonce
  );
  decipher.setAAD(localMcpAuthorizationReplayAad(requestId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function normalizeApiKeyHeader(request) {
	const headers = request?.headers || {};
	if (!headers.authorization && !headers["x-lico-tool-token"] && headers["x-licomesh-api-key"]) {
		headers["x-lico-tool-token"] = String(headers["x-licomesh-api-key"] || "").trim();
	}
}

export function parseRequestBody(requestBody) {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function isSameOriginBrowserRequest(request) {
  const origin = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  if (origin === "null" || !isLocalHttpOrigin(origin)) {
    return false;
  }
  const host = String(request?.headers?.host || "").trim();
  if (!isLocalHttpHost(host)) {
    return false;
  }
  return originHost(origin) === host.toLowerCase();
}

export function hasMcpForwardingMetadata(request) {
  const headers = request?.headers || {};
  return Object.entries(headers).some(([name, value]) => {
    const normalizedName = String(name || "").trim().toLowerCase();
    return (normalizedName === "forwarded" ||
      normalizedName === "x-real-ip" ||
      normalizedName.startsWith("x-forwarded-")) &&
      Boolean(String(value || "").trim());
  });
}

function isValidDirectMcpHost(value = "") {
  const host = String(value || "").trim();
  if (!host || host.length > 512 || /[\s/@\\?#]/u.test(host)) {
    return false;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return Boolean(parsed.hostname) && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isSameOriginDirectMcpRequest(request) {
  const origin = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host.toLowerCase() === String(request?.headers?.host || "").trim().toLowerCase();
  } catch {
    return false;
  }
}

export function isDirectMcpClientRequest(request) {
  const host = String(request?.headers?.host || "").trim();
  return !hasMcpForwardingMetadata(request) &&
    Boolean(clientIpFromRequest(request)) &&
    isValidDirectMcpHost(host) &&
    isSameOriginDirectMcpRequest(request);
}

export function isLocalMcpPairingRequest(request) {
  const host = String(request?.headers?.host || "").trim();
  return !hasMcpForwardingMetadata(request) &&
    isLoopbackAddress(clientIpFromRequest(request)) &&
    isLocalHttpHost(host) &&
    isSameOriginBrowserRequest(request);
}

export function localMcpGrantTargets(grant) {
  const metadata = grantMetadata(grant);
  return [
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ].filter((target, index, values) => values.indexOf(target) === index);
}

export function isLocalMcpGrant(grant) {
  const metadata = grantMetadata(grant);
  return (
    String(metadata.issuedBy || "").trim() === "lico-mcp-local-pairing" ||
    String(grant?.type || "").trim() === "mcp-client"
  );
}

export function localMcpGrantTargetKeys(grant) {
  const metadata = grantMetadata(grant);
  return normalizedGrantTargetKeys([
    ...normalizeGrantTargets(metadata.targets),
    ...normalizeGrantTargets(metadata.mcpTarget)
  ]);
}

export function localGrantTargetMatch(targets = []) {
  const matchedTargets = [];
  const unmatchedTargets = [];
  const toolsets = new Set();
  let agentProfileId = "";
  for (const target of targets) {
    const key = normalizedTargetKey(target);
    const profile = LOCAL_GRANT_TARGET_MATCH[key] || null;
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

export function localGrantSupportedTargets() {
  return Object.keys(LOCAL_GRANT_TARGET_MATCH);
}

export function localGrantSupportedTargetDetails() {
  return Object.entries(LOCAL_GRANT_TARGET_MATCH).map(([target, profile]) => ({
    target,
    agentProfileId: profile.agentProfileId || "",
    toolsets: [...(profile.toolsets || [])],
    maxRisk: "read_only"
  }));
}

export function localGrantMatchedTargetDetails(targets = []) {
  return targets
    .map((target) => {
      const profile = LOCAL_GRANT_TARGET_MATCH[normalizedTargetKey(target)] || null;
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

export function localGrantRequestBaseUrl({ request = null, discoveryState = null } = {}) {
  const activeServiceUrl = String(discoveryState?.activeServiceUrl || "").replace(/\/+$/, "");
  if (activeServiceUrl) {
    return activeServiceUrl;
  }
  const host = String(request?.headers?.host || "").trim();
  if (!host) {
    return "";
  }
  const forwardedProto = String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (request?.socket?.encrypted ? "https" : "http");
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

export function localGrantVmBaseUrl(baseUrl = "") {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//host.orb.internal:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "";
  }
}

export function localGrantShellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

export function localGrantGithubOneLineCommand(scriptName = LOCAL_GRANT_BOOTSTRAP_SCRIPT) {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(scriptName || ""))) {
    throw new Error("invalid_local_installer_name");
  }
  return `/bin/sh -c 'exec /bin/sh ./${scriptName} "$@"'`;
}

export function localGrantGithubOneLineInstallCommands({ baseUrl = "" } = {}) {
  const urlArgs = baseUrl ? ` --url ${localGrantShellQuote(baseUrl)}` : "";
  const command = localGrantGithubOneLineCommand();
  const commandZhCN = localGrantGithubOneLineCommand(LOCAL_GRANT_BOOTSTRAP_SCRIPT_ZH_CN);
  const priorityTargets = LOCAL_GRANT_PRIORITY_TARGETS.join(",");
  const build = (oneLineCommand) => ({
    installCommand: urlArgs ? `${oneLineCommand} --${urlArgs}` : oneLineCommand,
    clientInstallJsonCommand: `${oneLineCommand} -- --target <client>${urlArgs} --json`,
    autoInstallCommand: `${oneLineCommand} -- --target auto${urlArgs} --json`,
    priorityInstallCommand: `${oneLineCommand} -- --target ${priorityTargets}${urlArgs} --json`
  });
  const english = build(command);
  const zhCN = build(commandZhCN);
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

export function localGrantConnectorMetadata({ request = null, discoveryState = null } = {}) {
  const baseUrl = localGrantRequestBaseUrl({ request, discoveryState });
  const urlArgs = baseUrl ? ` --url ${localGrantShellQuote(baseUrl)}` : "";
  const oneLineCommands = localGrantGithubOneLineInstallCommands({ baseUrl });
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

export function localGrantSharedHubContract({ request = null, discoveryState = null } = {}) {
  const baseUrl = localGrantRequestBaseUrl({ request, discoveryState });
  const vmBaseUrl = localGrantVmBaseUrl(baseUrl);
  return {
    canonicalMcpUrl: baseUrl ? `${baseUrl}/mcp` : "",
    vmMcpUrl: vmBaseUrl ? `${vmBaseUrl}/mcp` : "",
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

export function localGrantRiskRank(risk = "read_only") {
  return LOCAL_GRANT_RISK_RANK[String(risk || "read_only")] ?? 0;
}

export function grantVisibleRisk(grant = null) {
  const metadata = grantMetadata(grant);
  return String(metadata.maxRisk || grant?.maxRisk || "read_only").trim() || "read_only";
}

export function grantCanSeeTool(tool, grant = null) {
  if (!tool || tool.status !== "active" || !grant) {
    return false;
  }
  const deniedTools = new Set(normalizeGrantValues(grant.toolDeny || [], 256));
  if (deniedTools.has(tool.id)) {
    return false;
  }
  const allowedTools = new Set(normalizeGrantValues(grant.toolAllow || [], 256));
  if (allowedTools.size > 0 && !allowedTools.has(tool.id)) {
    return false;
  }
  const grantScopes = new Set(normalizeGrantValues(grant.scopes || [], 512));
  const missingScopes = (tool.requiredScopes || []).filter((scope) => !grantScopes.has(scope));
  if (missingScopes.length > 0) {
    return false;
  }
  const grantToolsets = new Set(normalizeGrantValues(grant.toolsets || [], 256));
  if (grantToolsets.size > 0 && !(tool.toolsets || []).some((toolset) => grantToolsets.has(toolset))) {
    return false;
  }
  if (localGrantRiskRank(tool.risk || "read_only") > localGrantRiskRank(grantVisibleRisk(grant))) {
    return false;
  }
  const dynamicCapability = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    ? tool.dynamicCapability
    : null;
  if (!dynamicCapability) return true;
  const metadata = grantMetadata(grant);
  const dynamicCapabilities = new Set([
    ...normalizeGrantValues(grant.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(grant.upstreamCapabilities || [], 512),
    ...normalizeGrantValues(metadata.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(metadata.upstreamCapabilities || [], 512)
  ]);
  const capabilityId = String(dynamicCapability.capabilityId || "").trim();
  if (!capabilityId || !dynamicCapabilities.has(capabilityId)) return false;
  const allowedServiceIds = new Set([
    ...normalizeGrantValues(grant.allowedServiceIds || [], 512),
    ...normalizeGrantValues(metadata.allowedServiceIds || [], 512)
  ]);
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(String(dynamicCapability.serviceId || ""))) {
    return false;
  }
  const allowedSecretBindings = new Set([
    ...normalizeGrantValues(grant.allowedSecretBindings || [], 512),
    ...normalizeGrantValues(metadata.allowedSecretBindings || [], 512)
  ]);
  return normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128).every((bindingId) =>
    allowedSecretBindings.has(bindingId) || dynamicCapabilities.has(`${capabilityId}:${bindingId}`)
  );
}

export function hasSafetyConfirm(request = null) {
  const value = String(
    request?.headers?.["x-lico-safety-confirm"] ||
      request?.headers?.["x-lico-confirm"] ||
      ""
  ).toLowerCase();
  return ["1", "true", "yes"].includes(value);
}

export function requestedLocalGrantMaxRisk(body = {}, resolved = {}) {
  const requested = String(body.maxRisk || body.max_risk || "").trim();
  if (LOCAL_GRANT_RISK_RANK[requested] !== undefined) {
    return requested;
  }
  const grantMode = String(body.grantMode || body.grant_mode || body.mode || "").trim();
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

export function denyLocalGrant(status, code, message, details = {}) {
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

export function hashLocalMcpAuthorizationClaim(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function isLocalMcpAuthorizationClaimHash(value = "") {
  return /^[a-f0-9]{64}$/u.test(String(value || "").trim());
}

export function localMcpAuthorizationVerificationCode(claimTokenHash = "") {
  const normalized = String(claimTokenHash || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(normalized)) {
    return "";
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
}

export function localMcpProcessKeyFingerprint(processIdentityRequest = {}) {
  const publicKey = String(
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
}) {
  const resolvedRisk = String(resolved.maxRisk || "read_only");
  if (!securityPermissions || typeof securityPermissions.authorizeOperation !== "function") {
    return denyLocalGrant(
      503,
      "console_authorization_unavailable",
      "MCP local grant issuance requires console authorization.",
      { maxRisk: resolvedRisk, matchedLocalTarget: matchedLocalTarget === true }
    );
  }
  const authorization = await securityPermissions.authorizeOperation({
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
      "Write-capable MCP local grants require x-lico-safety-confirm: true.",
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

export function slugText(value, fallback = "target") {
  const normalized = compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function mcpGrantConnectionState(grant, { offlineAfterSeconds = 0 } = {}) {
  if (compactText(grant?.revokedAt)) {
    return { state: "revoked", label: "已撤销", alignmentState: "offline" };
  }
  if (grant?.enabled === false) {
    return { state: "disabled", label: "停用", alignmentState: "offline" };
  }

  const lastUsedAt = compactText(grant?.lastUsedAt);
  if (!lastUsedAt) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(lastUsedAt).getTime()) / 1000));
  if (!Number.isFinite(ageSeconds)) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }
  const offlineThreshold = Number(offlineAfterSeconds || 0);
  if (offlineThreshold <= 0) {
    return { state: "unknown", label: "未配置离线阈值", alignmentState: "unknown" };
  }
  if (ageSeconds > offlineThreshold) {
    return { state: "offline", label: "离线", alignmentState: "offline" };
  }

  return { state: "connected", label: "在线", alignmentState: "unknown" };
}

export function isMcpGrantTargetUninstalled(grant, target) {
  const metadata = grantMetadata(grant);
  const uninstalledTargets = normalizedGrantTargetKeys(metadata.uninstalledTargets);
  if (uninstalledTargets.includes(normalizedTargetKey(target))) {
    return true;
  }
  return metadata.currentDeviceVisible === false && Boolean(compactText(metadata.uninstalledAt));
}

export function mcpGrantClientRows(grant, { offlineAfterSeconds = 0 } = {}) {
  const connection = mcpGrantConnectionState(grant, { offlineAfterSeconds });
  const metadata = grantMetadata(grant);
  const targets = localMcpGrantTargets(grant).length > 0
    ? localMcpGrantTargets(grant)
    : [compactText(grant?.label).replace(/\s*\(MCP Client\)\s*$/i, "") || compactText(grant?.id) || "MCP 插件"];
  return targets
    .filter((target) => !isMcpGrantTargetUninstalled(grant, target))
    .map((target, index) => {
      const targetKey = targets.length > 1 ? `${slugText(target)}-${index + 1}` : slugText(target);
      const lastSeenAt = compactText(grant.lastUsedAt || grant.updatedAt || grant.createdAt);
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
