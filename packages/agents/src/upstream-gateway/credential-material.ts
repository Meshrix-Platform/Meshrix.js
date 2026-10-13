import { createHash } from "node:crypto";
import { resolveUpstreamCredentialMaterial } from "@meshrix/contracts/upstream-service-publishing";
import { resolveLocalSecretPayload } from "@meshrix/foundation/security/secrets/local-secret-store";
import type { LocalSecretKeyProvider } from "@meshrix/foundation/security/secrets/local-secret-key-provider";
import {
  asArray,
  mcpServiceConfig,
  object,
  text
} from "./support.ts";
import type {
  UpstreamGatewayNormalizedService,
  UpstreamGatewayOperationSelection,
  UpstreamGatewayResolvedCredentialMaterial,
  UpstreamGatewayResolvedMcpServiceConfig,
  UpstreamGatewayServiceRecord
} from "./registry-types.ts";

type UpstreamGatewayCredentialService =
  | UpstreamGatewayServiceRecord
  | UpstreamGatewayNormalizedService;

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

function trustedExecutionIdentity(subject: Record<string, any> = {}) : any {
  const grant: any = object(subject.grant);
  const user: any = object(subject.user);
  const principalId: any = text(
    subject.subjectId ||
    subject.workloadPrincipalId ||
    user.subjectId ||
    user.userId ||
    grant.subjectId ||
    subject.id
  );
  const grantId: any = text(subject.grantId || grant.id || grant.grantId);
  if (!principalId && !grantId) {
    return { principalId: "", grantId: "", trusted: false };
  }
  return {
    principalId: principalId || grantId,
    grantId: grantId || principalId,
    trusted: true
  };
}

function executionPrincipalRequiredError() : any {
  return Object.assign(new Error("Trusted execution principal is required for a stateful upstream MCP session."), {
    status: 403,
    reasonCode: "upstream_mcp_execution_principal_required"
  });
}

function mcpSessionPurpose(value: any = "discovery") : any {
  const purpose: any = text(value);
  if (purpose === "execution" || purpose === "health") return purpose;
  return "discovery";
}

function mcpSessionKey({
  service = {},
  config = {},
  credentialRevisions = [],
  purpose = "discovery",
  principalId = "",
  grantId = ""
}: Record<string, any> = {}) : any {
  const sessionPurpose: any = mcpSessionPurpose(purpose);
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
      .sort((left?: any, right?: any) : any => left.secretRef.localeCompare(right.secretRef)),
    purpose: sessionPurpose,
    ...(sessionPurpose === "execution"
      ? {
          principalId: text(principalId),
          grantId: text(grantId)
        }
      : {})
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
}: {
  userDataPath?: string;
  service: UpstreamGatewayCredentialService;
  operation?: UpstreamGatewayOperationSelection;
  targetUrl?: URL | null;
  secretKeyProvider?: LocalSecretKeyProvider | null;
}) : Promise<UpstreamGatewayResolvedCredentialMaterial> {
  const target: any = targetUrl || parseOptionalUrl(service.baseUrl || service.mcp?.url || "");
  const declaredBindings: any = asArray(service.credentialReferences)
    .filter((entry?: any) : any => entry && typeof entry === "object" && !Array.isArray(entry));
  const candidateBindings: any = (declaredBindings.length > 0
    ? declaredBindings
    : asArray(service.credentialRefs).map((reference?: any) : any => ({ reference })))
    .filter((entry?: any) : any => entry && typeof entry === "object" && !Array.isArray(entry));
  if (candidateBindings.length === 0) {
    return {
      headers: {},
      env: {},
      credentialRefCount: 0,
      resolvedCredentialRefCount: 0,
      credentialRevisions: []
    };
  }
  if (!target) {
    throw Object.assign(new Error("Upstream credential binding was denied."), {
      status: 403,
      reasonCode: "upstream_credential_binding_denied"
    });
  }
  const operationScopes = asArray(operation.requiredScopes).map(text).filter(Boolean);
  const resolved = await resolveUpstreamCredentialMaterial({
    bindings: candidateBindings,
    targetOrigin: target.origin,
    operationKey: text(operation.operationKey),
    requiredScopes: operationScopes,
    resolveSecretPayload: async (binding, targetOrigin) => {
      const targetUrl = new URL(targetOrigin);
      const localResolved: any = await resolveLocalSecretPayload({
        dataDir: userDataPath,
        secretRef: binding.reference,
        ...(Number.isSafeInteger(binding.revision) && Number(binding.revision) > 0
          ? { expectedRevision: binding.revision }
          : {}),
        expectedScope: {
          serviceId: service.serviceId,
          requiredScopes: operationScopes,
          origin: targetOrigin,
          host: targetUrl.hostname.replace(/^\[|\]$/gu, ""),
          protocol: targetUrl.protocol.slice(0, -1)
        },
        keyProvider: secretKeyProvider
      });
      return {
        secretRef: localResolved.secretRef,
        revision: localResolved.revision,
        payload: localResolved.payload
      };
    }
  });
  return resolved as UpstreamGatewayResolvedCredentialMaterial;
}

export async function resolveMcpServiceConfigWithCredentials({
  userDataPath = "",
  service,
  operation = {},
  secretKeyProvider = null,
  purpose = "discovery",
  subject = null
}: {
  userDataPath?: string;
  service: UpstreamGatewayCredentialService;
  operation?: UpstreamGatewayOperationSelection;
  secretKeyProvider?: LocalSecretKeyProvider | null;
  purpose?: string;
  subject?: Readonly<Record<string, unknown>> | null;
}) : Promise<UpstreamGatewayResolvedMcpServiceConfig> {
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
  const sessionPurpose: any = mcpSessionPurpose(purpose);
  const trusted: any = sessionPurpose === "execution" ? trustedExecutionIdentity(subject || {}) : { trusted: false };
  if (sessionPurpose === "execution" && trusted.trusted !== true) {
    throw executionPrincipalRequiredError();
  }
  const serviceId: any = text(service.serviceId);
  return {
    ...config,
    gatewayServiceId: config.gatewayServiceId,
    allowLocalNetwork: config.allowLocalNetwork,
    sessionKey: mcpSessionKey({
      service,
      config,
      credentialRevisions: credentials.credentialRevisions,
      purpose: sessionPurpose,
      principalId: trusted.principalId,
      grantId: trusted.grantId
    }),
    sessionGeneration: mcpSessionGeneration({
      service,
      credentialRevisions: credentials.credentialRevisions
    }),
    sessionScope: sessionPurpose === "execution"
      ? `svc:${serviceId}:exec:${text(trusted.principalId)}:${text(trusted.grantId)}`
      : `svc:${serviceId}:${sessionPurpose}`,
    sessionKind: sessionPurpose === "execution" ? "stateful" : "ephemeral",
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
