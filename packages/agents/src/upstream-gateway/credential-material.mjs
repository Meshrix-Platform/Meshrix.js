import { createHash } from "node:crypto";
import { resolveLocalSecretPayload } from "@lico/foundation/security/secrets/local-secret-store";
import {
  asArray,
  mcpServiceConfig,
  object,
  text
} from "./support.mjs";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function stableSessionIdentity(value) {
  if (Array.isArray(value)) {
    return value.map(stableSessionIdentity);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSessionIdentity(value[key])])
  );
}

function mcpSessionKey({ service = {}, config = {}, credentialRevisions = [] } = {}) {
  const identity = stableSessionIdentity({
    serviceId: text(service.serviceId),
    serviceUpdatedAt: text(service.updatedAt),
    serviceBaseUrl: text(service.baseUrl),
    transportConfig: object(config),
    credentialRevisions: asArray(credentialRevisions)
      .map((entry) => ({
        secretRef: text(entry.secretRef),
        revision: Number(entry.revision || 0)
      }))
      .sort((left, right) => left.secretRef.localeCompare(right.secretRef))
  });
  return `upstream-mcp:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function mcpSessionGeneration({ service = {}, credentialRevisions = [] } = {}) {
  return Object.freeze({
    serviceRevision: Math.max(0, Number(service.serviceRevision || service.revision || 0) || 0),
    credentialRevisions: Object.freeze(asArray(credentialRevisions)
      .map((entry) => Object.freeze({
        bindingId: createHash("sha256").update(text(entry.secretRef)).digest("base64url"),
        revision: Math.max(0, Number(entry.revision || 0) || 0)
      }))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId)))
  });
}

function normalizeSecretHeaderName(value = "") {
  const name = text(value).toLowerCase();
  return name && HEADER_NAME_PATTERN.test(name) ? name : "";
}

function normalizeSecretMaterialValue(value) {
  if (value === undefined || value === null) return "";
  const raw = String(value);
  return /[\r\n\u0000]/u.test(raw) ? "" : raw;
}

function firstSecretText(payload = {}, keys = []) {
  for (const key of keys) {
    const value = normalizeSecretMaterialValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function mergeMaterial(target = {}, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

function headersFromSecretPayload(payload = {}) {
  const source = object(payload);
  const headers = {};
  for (const [key, value] of Object.entries(object(source.headers || source.header))) {
    const name = normalizeSecretHeaderName(key);
    const material = normalizeSecretMaterialValue(value);
    if (name && material) {
      headers[name] = material;
    }
  }
  const explicitHeaderName = normalizeSecretHeaderName(source.headerName || source.name);
  const explicitHeaderValue = normalizeSecretMaterialValue(source.headerValue ?? source.value);
  if (explicitHeaderName && explicitHeaderValue) {
    headers[explicitHeaderName] = explicitHeaderValue;
  }
  const authorization = firstSecretText(source, ["authorization", "authHeader"]);
  if (authorization && !headers.authorization) {
    headers.authorization = authorization;
  }
  const bearerToken = firstSecretText(source, ["bearerToken", "accessToken", "token"]) ||
    normalizeSecretMaterialValue(object(source.oauth).accessToken);
  if (bearerToken && !headers.authorization) {
    headers.authorization = /^Bearer\s+/iu.test(bearerToken)
      ? bearerToken
      : `Bearer ${bearerToken}`;
  }
  const apiKey = firstSecretText(source, ["apiKey", "api_key", "key"]);
  if (apiKey && !headers["x-api-key"]) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

function envFromSecretPayload(payload = {}) {
  const source = object(payload);
  const env = {};
  for (const [key, value] of Object.entries(object(source.env || source.environment))) {
    const name = text(key);
    const material = normalizeSecretMaterialValue(value);
    if (ENV_NAME_PATTERN.test(name) && material) {
      env[name] = material;
    }
  }
  const explicitName = text(source.envName || source.environmentName);
  const explicitValue = normalizeSecretMaterialValue(source.envValue ?? source.value);
  if (ENV_NAME_PATTERN.test(explicitName) && explicitValue) {
    env[explicitName] = explicitValue;
  }
  return env;
}

function urlScope(url = null) {
  if (!url) {
    return { host: "", protocol: "" };
  }
  return {
    host: text(url.hostname),
    protocol: text(url.protocol).replace(/:$/, "")
  };
}

function parseOptionalUrl(value = "") {
  try {
    return text(value) ? new URL(value) : null;
  } catch {
    return null;
  }
}

export async function resolveCredentialMaterial({ userDataPath = "", service, operation = {}, targetUrl = null } = {}) {
  const target = targetUrl || parseOptionalUrl(service.baseUrl || service.mcp?.url || "");
  const declaredBindings = asArray(service.credentialReferences)
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  const bindings = (declaredBindings.length > 0
    ? declaredBindings
    : asArray(service.credentialRefs).map((reference) => ({ reference })))
    .filter((entry) => !text(entry.operationKey) || text(entry.operationKey) === text(operation.operationKey));
  if (bindings.length === 0) {
    return {
      headers: {},
      env: {},
      credentialRefCount: 0,
      resolvedCredentialRefCount: 0,
      credentialRevisions: []
    };
  }
  const material = {
    headers: {},
    env: {},
    credentialRefCount: bindings.length,
    resolvedCredentialRefCount: 0,
    credentialRevisions: []
  };
  const scope = {
    serviceId: service.serviceId,
    requiredScopes: asArray(operation.requiredScopes).map(text).filter(Boolean),
    ...urlScope(target)
  };
  const operationScopes = new Set(asArray(operation.requiredScopes).map(text).filter(Boolean));
  for (const binding of bindings) {
    const secretRef = text(binding.reference);
    const targetScope = urlScope(target);
    const bindingScopes = asArray(binding.scopes).map(text).filter(Boolean);
    if (!secretRef.startsWith("secret://")) {
      throw Object.assign(new Error("Upstream gateway credential authority is unavailable for this reference scheme."), {
        status: 503,
        reasonCode: "upstream_credential_authority_unsupported",
        credentialRefCount: bindings.length,
        resolvedCredentialRefCount: material.resolvedCredentialRefCount
      });
    }
    if ((text(binding.host) && text(binding.host).toLowerCase() !== targetScope.host.toLowerCase()) ||
        (text(binding.protocol) && text(binding.protocol).toLowerCase() !== targetScope.protocol.toLowerCase()) ||
        bindingScopes.some((requiredScope) => !operationScopes.has(requiredScope))) {
      throw Object.assign(new Error("Upstream gateway credential binding does not match the selected operation."), {
        status: 403,
        reasonCode: "upstream_credential_binding_denied",
        credentialRefCount: bindings.length,
        resolvedCredentialRefCount: material.resolvedCredentialRefCount
      });
    }
    try {
      const resolved = await resolveLocalSecretPayload({
        dataDir: userDataPath,
        secretRef,
        ...(Number.isSafeInteger(binding.revision) && binding.revision > 0
          ? { expectedRevision: binding.revision }
          : {}),
        expectedScope: scope
      });
      mergeMaterial(material.headers, headersFromSecretPayload(resolved.payload));
      mergeMaterial(material.env, envFromSecretPayload(resolved.payload));
      material.credentialRevisions.push({
        secretRef: resolved.secretRef,
        revision: resolved.revision
      });
      material.resolvedCredentialRefCount += 1;
    } catch (error) {
      const status = error?.code === "local_secret_scope_denied" ? 403 : 503;
      throw Object.assign(new Error("Upstream gateway credential resolution failed."), {
        status,
        reasonCode: error?.code || "upstream_credential_resolution_failed",
        credentialRefCount: bindings.length,
        resolvedCredentialRefCount: material.resolvedCredentialRefCount
      });
    }
  }
  return material;
}

export async function resolveMcpServiceConfigWithCredentials({ userDataPath = "", service, operation = {} } = {}) {
  const config = {
    ...mcpServiceConfig(service),
    gatewayServiceId: text(service.serviceId),
    allowLocalNetwork: service.allowLocalNetwork === true
  };
  const credentials = await resolveCredentialMaterial({
    userDataPath,
    service,
    operation,
    targetUrl: parseOptionalUrl(config.url || service.baseUrl || "")
  });
  const allowCredentialEnvironment = text(config.transport).toLowerCase() === "stdio";
  return {
    ...config,
    sessionKey: mcpSessionKey({
      service,
      config,
      credentialRevisions: credentials.credentialRevisions
    }),
    sessionGeneration: mcpSessionGeneration({
      service,
      credentialRevisions: credentials.credentialRevisions
    }),
    sessionScope: text(service.serviceId),
    headers: {
      ...object(config.headers),
      ...credentials.headers
    },
    env: {
      ...object(config.env),
      ...(allowCredentialEnvironment ? credentials.env : {})
    }
  };
}
