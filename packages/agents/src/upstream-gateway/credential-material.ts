import { createHash } from "node:crypto";
import { resolveLocalSecretPayload } from "@meshrix/foundation/security/secrets/local-secret-store";
import {
  asArray,
  mcpServiceConfig,
  object,
  text
} from "./support.ts";

const HEADER_NAME_PATTERN: any = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ENV_NAME_PATTERN: any = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function stableSessionIdentity(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map(stableSessionIdentity);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key?: any) : any => [key, stableSessionIdentity(value[key])])
  );
}

function mcpSessionKey({ service = {}, config = {}, credentialRevisions = [] }: Record<string, any> = {}) : any {
  const identity: any = stableSessionIdentity({
    serviceId: text(service.serviceId),
    serviceUpdatedAt: text(service.updatedAt),
    serviceBaseUrl: text(service.baseUrl),
    transportConfig: object(config),
    credentialRevisions: asArray(credentialRevisions)
      .map((entry?: any) : any => ({
        secretRef: text(entry.secretRef),
        revision: Number(entry.revision || 0)
      }))
      .sort((left?: any, right?: any) : any => left.secretRef.localeCompare(right.secretRef))
  });
  return `upstream-mcp:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function mcpSessionGeneration({ service = {}, credentialRevisions = [] }: Record<string, any> = {}) : any {
  return Object.freeze({
    serviceRevision: Math.max(0, Number(service.serviceRevision || service.revision || 0) || 0),
    credentialRevisions: Object.freeze(asArray(credentialRevisions)
      .map((entry?: any) : any => Object.freeze({
        bindingId: createHash("sha256").update(text(entry.secretRef)).digest("base64url"),
        revision: Math.max(0, Number(entry.revision || 0) || 0)
      }))
      .sort((left?: any, right?: any) : any => left.bindingId.localeCompare(right.bindingId)))
  });
}

function normalizeSecretHeaderName(value: any = "") : any {
  const name: any = text(value).toLowerCase();
  return name && HEADER_NAME_PATTERN.test(name) ? name : "";
}

function normalizeSecretMaterialValue(value?: any) : any {
  if (value === undefined || value === null) return "";
  const raw: any = String(value);
  return /[\r\n\u0000]/u.test(raw) ? "" : raw;
}

function firstSecretText(payload: Record<string, any> = {}, keys: any = []) : any {
  for (const key of keys) {
    const value: any = normalizeSecretMaterialValue(payload[key]);
    if (value) return value;
  }
  return "";
}

function mergeMaterial(target: Record<string, any> = {}, source: Record<string, any> = {}) : any {
  for (const [key, value] of (Object.entries(source) as [string, any][])) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

function headersFromSecretPayload(payload: Record<string, any> = {}) : any {
  const source: any = object(payload);
  const headers: Record<string, any> = {};
  for (const [key, value] of (Object.entries(object(source.headers || source.header)) as [string, any][])) {
    const name: any = normalizeSecretHeaderName(key);
    const material: any = normalizeSecretMaterialValue(value);
    if (name && material) {
      headers[name] = material;
    }
  }
  const explicitHeaderName: any = normalizeSecretHeaderName(source.headerName || source.name);
  const explicitHeaderValue: any = normalizeSecretMaterialValue(source.headerValue ?? source.value);
  if (explicitHeaderName && explicitHeaderValue) {
    headers[explicitHeaderName] = explicitHeaderValue;
  }
  const authorization: any = firstSecretText(source, ["authorization", "authHeader"]);
  if (authorization && !headers.authorization) {
    headers.authorization = authorization;
  }
  const bearerToken: any = firstSecretText(source, ["bearerToken", "accessToken", "token"]) ||
    normalizeSecretMaterialValue(object(source.oauth).accessToken);
  if (bearerToken && !headers.authorization) {
    headers.authorization = /^Bearer\s+/iu.test(bearerToken)
      ? bearerToken
      : `Bearer ${bearerToken}`;
  }
  const apiKey: any = firstSecretText(source, ["apiKey", "api_key", "key"]);
  if (apiKey && !headers["x-api-key"]) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

function envFromSecretPayload(payload: Record<string, any> = {}) : any {
  const source: any = object(payload);
  const env: Record<string, any> = {};
  for (const [key, value] of (Object.entries(object(source.env || source.environment)) as [string, any][])) {
    const name: any = text(key);
    const material: any = normalizeSecretMaterialValue(value);
    if (ENV_NAME_PATTERN.test(name) && material) {
      env[name] = material;
    }
  }
  const explicitName: any = text(source.envName || source.environmentName);
  const explicitValue: any = normalizeSecretMaterialValue(source.envValue ?? source.value);
  if (ENV_NAME_PATTERN.test(explicitName) && explicitValue) {
    env[explicitName] = explicitValue;
  }
  return env;
}

function urlScope(url: any = null) : any {
  if (!url) {
    return { host: "", protocol: "" };
  }
  return {
    host: text(url.hostname),
    protocol: text(url.protocol).replace(/:$/, "")
  };
}

function parseOptionalUrl(value: any = "") : any {
  try {
    return text(value) ? new URL(value) : null;
  } catch {
    return null;
  }
}

export async function resolveCredentialMaterial({
  userDataPath = "",
  service,
  operation = {},
  targetUrl = null,
  secretKeyProvider = null
}: Record<string, any> = {}) : Promise<any> {
  const target: any = targetUrl || parseOptionalUrl(service.baseUrl || service.mcp?.url || "");
  const declaredBindings: any = asArray(service.credentialReferences)
    .filter((entry?: any) : any => entry && typeof entry === "object" && !Array.isArray(entry));
  const bindings: any = (declaredBindings.length > 0
    ? declaredBindings
    : asArray(service.credentialRefs).map((reference?: any) : any => ({ reference })))
    .filter((entry?: any) : any => !text(entry.operationKey) || text(entry.operationKey) === text(operation.operationKey));
  if (bindings.length === 0) {
    return {
      headers: {},
      env: {},
      credentialRefCount: 0,
      resolvedCredentialRefCount: 0,
      credentialRevisions: []
    };
  }
  const material: Record<string, any> = {
    headers: {},
    env: {},
    credentialRefCount: bindings.length,
    resolvedCredentialRefCount: 0,
    credentialRevisions: []
  };
  const scope: Record<string, any> = {
    serviceId: service.serviceId,
    requiredScopes: asArray(operation.requiredScopes).map(text).filter(Boolean),
    ...urlScope(target)
  };
  const operationScopes: any = new Set<any>(asArray(operation.requiredScopes).map(text).filter(Boolean));
  for (const binding of bindings) {
    const secretRef: any = text(binding.reference);
    const targetScope: any = urlScope(target);
    const bindingScopes: any = asArray(binding.scopes).map(text).filter(Boolean);
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
        bindingScopes.some((requiredScope?: any) : any => !operationScopes.has(requiredScope))) {
      throw Object.assign(new Error("Upstream gateway credential binding does not match the selected operation."), {
        status: 403,
        reasonCode: "upstream_credential_binding_denied",
        credentialRefCount: bindings.length,
        resolvedCredentialRefCount: material.resolvedCredentialRefCount
      });
    }
    try {
      const resolved: any = await resolveLocalSecretPayload({
        dataDir: userDataPath,
        secretRef,
        ...(Number.isSafeInteger(binding.revision) && binding.revision > 0
          ? { expectedRevision: binding.revision }
          : {}),
        expectedScope: scope,
        keyProvider: secretKeyProvider
      });
      mergeMaterial(material.headers, headersFromSecretPayload(resolved.payload));
      mergeMaterial(material.env, envFromSecretPayload(resolved.payload));
      material.credentialRevisions.push({
        secretRef: resolved.secretRef,
        revision: resolved.revision
      });
      material.resolvedCredentialRefCount += 1;
    } catch (error: any) {
      const status: any = error?.code === "local_secret_scope_denied" ? 403 : 503;
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

export async function resolveMcpServiceConfigWithCredentials({
  userDataPath = "",
  service,
  operation = {},
  secretKeyProvider = null
}: Record<string, any> = {}) : Promise<any> {
  const config: Record<string, any> = {
    ...mcpServiceConfig(service),
    gatewayServiceId: text(service.serviceId),
    allowLocalNetwork: service.allowLocalNetwork === true
  };
  const credentials: any = await resolveCredentialMaterial({
    userDataPath,
    service,
    operation,
    secretKeyProvider,
    targetUrl: parseOptionalUrl(config.url || service.baseUrl || "")
  });
  const allowCredentialEnvironment: any = text(config.transport).toLowerCase() === "stdio";
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
