import {
  CONCURRENCY_GROUP_DECORATORS,
  DEFAULT_REPAIR_APPROVAL_SCOPE,
  EXTERNAL_AUTH_MISSING_CODE_DECORATORS,
  EXTERNAL_AUTH_OPERATION_IDS,
  EXTERNAL_AUTH_VERIFIER_DECORATORS,
  MAINTENANCE_AGENT_RISKS,
  OPERATION_ASPECTS,
  OPERATION_PROOF_PROFILES,
  PROOF_EXCLUDED_OPERATION_IDS,
  PUBLIC_OPERATION_IDS,
  READ_ONLY_POST_OPERATION_IDS,
  REQUIRED_SCOPE_DECORATORS,
  SAFETY_DECORATORS,
  maxRisk,
  normalizeRisk,
  riskRank
} from "./operation-policy-constants.mjs";

export {
  OPERATION_ASPECTS,
  OPERATION_PROOF_PROFILES
} from "./operation-policy-constants.mjs";

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function withAspect(aspect, options = {}) {
  return (operation) => ({
    ...operation,
    aspects: uniqueStrings([...(operation.aspects || []), aspect]),
    aspectOptions: {
      ...(operation.aspectOptions || {}),
      [aspect]: {
        ...(operation.aspectOptions?.[aspect] || {}),
        ...options
      }
    }
  });
}

export function withRequiredScopes(scopes = []) {
  return (operation) => ({
    ...operation,
    requiredScopes: uniqueStrings([...(operation.requiredScopes || []), ...scopes])
  });
}

export function withScopes(scopes = []) {
  return withRequiredScopes(scopes);
}

export function withTransport(transport = {}) {
  return (operation) => ({
    ...operation,
    http: transport.http || operation.http,
    rpc: transport.rpc === undefined ? operation.rpc : transport.rpc,
    cli: transport.cli === undefined ? operation.cli : transport.cli,
    binary: transport.binary === undefined ? operation.binary : Boolean(transport.binary)
  });
}

export function withTarget(target = {}) {
  return (operation) => ({
    ...operation,
    target: {
      ...(operation.target || {}),
      ...target
    }
  });
}

export function withSafety(safety = {}) {
  return (operation) => ({
    ...operation,
    safety: normalizeOperationSafety({
      ...(operation.safety || {}),
      ...safety
    }, operation)
  });
}

export function withRisk(risk, options = {}) {
  return withSafety({ ...options, risk });
}

export function withInputSchema(inputSchema = {}) {
  return (operation) => ({
    ...operation,
    inputSchema: normalizeInputSchema(inputSchema, operation)
  });
}

export function withAudit(audit = {}) {
  return (operation) => ({
    ...operation,
    audit: normalizeAuditPolicy({ ...(operation.audit || {}), ...audit }, operation)
  });
}

export function withConcurrency(concurrency = {}) {
  return (operation) => {
    const concurrencySafe =
      typeof concurrency === "boolean"
        ? concurrency
        : concurrency.concurrencySafe === undefined
          ? operation.concurrencySafe
          : concurrency.concurrencySafe;
    return {
      ...operation,
      concurrencySafe: Boolean(concurrencySafe),
      concurrencyGroup:
        typeof concurrency === "object" && concurrency.group
          ? String(concurrency.group)
          : operation.concurrencyGroup || ""
    };
  };
}

export function defineOperation(definition, ...decorators) {
  return decorators.reduce((operation, decorator) => decorator(operation), { ...definition });
}

function inferOperationRisk(operation) {
  if (operation.readOnly === true) {
    return "read_only";
  }
  if (READ_ONLY_POST_OPERATION_IDS.has(operation.id)) {
    return "read_only";
  }

  const method = String(operation.http?.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return "read_only";
  }

  return "safe_write";
}

function normalizeOperationSafety(safety = {}, operation = {}) {
  const inferredRisk = inferOperationRisk(operation);
  const risk = normalizeRisk(safety.risk, inferredRisk);
  const isRepairOrHigher = riskRank(risk) >= riskRank("repair_write");
  const hasExplicitConfirmationMarker =
    Object.prototype.hasOwnProperty.call(safety, "requiresConfirmationExplicit");
  const requiresConfirmationExplicit = hasExplicitConfirmationMarker
    ? safety.requiresConfirmationExplicit === true
    : (
      Object.prototype.hasOwnProperty.call(safety, "requiresConfirmation") &&
      typeof safety.requiresConfirmation === "boolean"
    );
  return {
    risk,
    readOnly: safety.readOnly === undefined ? risk === "read_only" : safety.readOnly === true,
    destructive: safety.destructive === undefined ? risk === "destructive" : safety.destructive === true,
    approvalScope: safety.approvalScope || DEFAULT_REPAIR_APPROVAL_SCOPE,
    requiresConfirmation:
      requiresConfirmationExplicit
        ? safety.requiresConfirmation
        : isRepairOrHigher,
    requiresConfirmationExplicit,
    blocked: safety.blocked === true || risk === "destructive",
    reason: String(safety.reason || ""),
    resolveRisk: typeof safety.resolveRisk === "function" ? safety.resolveRisk : null
  };
}

function transportInputSchema(operation = {}) {
  const bindings = [
    ...(operation.http?.params || []),
    ...(operation.http?.query || []),
    ...(operation.rpc?.query || []),
    ...(operation.rpc?.params || []),
    ...(operation.cli?.bodyParams || [])
  ];
  const properties = {};
  const required = [];
  for (const binding of bindings) {
    const name = String(binding?.name || "").trim();
    if (!name) continue;
    const cliType = binding?.type;
    const coercion = operation.http?.coerce?.[name] || cliType;
    properties[name] = coercion === "json"
      ? {}
      : coercion === "string-list"
        ? { type: "array", items: { type: "string" } }
        : { type: coercion === "number" ? "number" : coercion === "boolean" ? "boolean" : "string" };
    if (binding.required === true) required.push(name);
  }
  return { properties, required: uniqueStrings(required) };
}

function normalizeInputSchema(inputSchema = {}, operation = {}) {
  const transportSchema = transportInputSchema(operation);
  const safety = normalizeOperationSafety(operation.safety || {}, operation);
  const confirmationProperties = safety.readOnly
    ? {}
    : {
        confirm: { type: "boolean" },
        safetyConfirm: { type: "boolean" }
      };
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return {
      type: "object",
      additionalProperties: false,
      ...transportSchema,
      properties: {
        ...transportSchema.properties,
        ...confirmationProperties
      }
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    ...inputSchema,
    required: uniqueStrings([...(inputSchema.required || []), ...transportSchema.required]),
    properties: {
      ...transportSchema.properties,
      ...confirmationProperties,
      ...(inputSchema.properties || {})
    }
  };
}

function normalizeAuditPolicy(audit = {}, operation = {}) {
  const method = String(operation.http?.method || "GET").toUpperCase();
  const safety = normalizeOperationSafety(operation.safety || audit.safety || {}, operation);
  const readOnly = safety.readOnly;
  const metadataOnly = audit.metadataOnly === true;
  return {
    enabled: audit.enabled === undefined ? true : audit.enabled !== false,
    recordInput: metadataOnly
      ? false
      : audit.recordInput === undefined
        ? !readOnly
        : audit.recordInput !== false,
    recordOutput: metadataOnly ? false : audit.recordOutput === true,
    metadataOnly,
    redaction: audit.redaction || "default",
    write: audit.write === undefined ? !["GET", "HEAD", "OPTIONS"].includes(method) : audit.write === true
  };
}

function normalizeLogPolicy(log = {}, operation = {}) {
  const safety = normalizeOperationSafety(operation.safety || {}, operation);
  return {
    enabled: log.enabled === undefined ? true : log.enabled !== false,
    redaction: log.redaction || operation.audit?.redaction || "default",
    recordInput: log.recordInput === undefined ? safety.readOnly !== true : log.recordInput === true,
    recordOutput: log.recordOutput === true
  };
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactResourceContext(value = {}) {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(value)).filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length > 0;
      }
      return entryValue !== undefined && entryValue !== null && entryValue !== "";
    })
  );
}

const RESOURCE_FIELD_ALIASES = Object.freeze({
  tenantId: ["tenantId", "tenant-id"],
  accountId: ["accountId", "account", "account-id"],
  endpointId: ["endpointId", "endpoint", "endpoint-id", "requesterEndpointId", "requester-endpoint-id"],
  opaqueMailboxId: ["opaqueMailboxId", "opaque-mailbox-id", "mailboxId", "mailbox-id", "mailbox"],
  workspaceId: [
    "workspaceId",
    "workspace",
    "workspace-id",
    "workspaceIds",
    "workspace-ids",
    "allowedWorkspaceIds",
    "allowed-workspace-ids",
    "metadata.allowedWorkspaceIds",
    "registryWorkspaceId",
    "registry-workspace-id",
    "targetWorkspaceId",
    "target-workspace-id",
    "parentWorkspaceId",
    "parent-workspace-id"
  ],
  dataClass: ["dataClass", "data-class", "allowedDataClasses", "allowed-data-classes", "metadata.allowedDataClasses"],
  dataClasses: ["dataClasses", "data-classes", "allowedDataClasses", "allowed-data-classes", "metadata.allowedDataClasses"],
  requestedEgress: ["requestedEgress", "requested-egress", "requestedEgresses", "requested-egresses", "allowedEgress", "allowed-egress", "metadata.allowedEgress"],
  serviceId: ["serviceId", "service-id", "serviceIds", "service-ids", "allowedServiceIds", "allowed-service-ids", "metadata.allowedServiceIds", "upstreamId", "upstream-id"],
  secretBindingId: [
    "secretBindingId",
    "secret-binding-id",
    "secretBindingIds",
    "secret-binding-ids",
    "allowedSecretBindings",
    "allowed-secret-bindings",
    "metadata.allowedSecretBindings",
    "authBindingId",
    "auth-binding-id",
    "bindingId",
    "binding-id",
    "credentialRef",
    "credentialRefs",
    "secretRef",
    "secretRefs"
  ],
  staticSemanticFamilyId: ["staticSemanticFamilyId", "static-semantic-family-id", "allowedStaticSemanticFamilies", "allowed-static-semantic-families", "metadata.allowedStaticSemanticFamilies", "familyId", "family-id"],
  capabilityDomain: ["capabilityDomain", "capability-domain", "allowedCapabilityDomains", "allowed-capability-domains", "metadata.allowedCapabilityDomains"],
  capabilityVerb: ["capabilityVerb", "capability-verb", "allowedCapabilityVerbs", "allowed-capability-verbs", "metadata.allowedCapabilityVerbs", "verb"],
  resourceKind: ["resourceKind", "resource-kind", "allowedResourceKinds", "allowed-resource-kinds", "metadata.allowedResourceKinds", "kind"],
  effectKind: ["effectKind", "effect-kind", "allowedEffectKinds", "allowed-effect-kinds", "metadata.allowedEffectKinds"]
});

const RESOURCE_KIND_BY_FEATURE = Object.freeze({
  agent_workspace: "workspace",
  external_services: "external_service",
  gateway: "external_service",
  module_management: "module",
  operation_permission: "operation_permission",
  tag_management: "tag"
});

function collectBindingNames(bindings = [], output = new Set()) {
  for (const binding of bindings || []) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    if (binding.name) {
      output.add(String(binding.name));
    }
    for (const alias of binding.aliases || []) {
      output.add(String(alias));
    }
  }
  return output;
}

function operationFieldNames(operation = {}) {
  const output = new Set(Object.keys(operation.inputSchema?.properties || {}));
  collectBindingNames(operation.http?.params, output);
  collectBindingNames(operation.http?.query, output);
  collectBindingNames(operation.rpc?.params, output);
  collectBindingNames(operation.rpc?.query, output);
  collectBindingNames(operation.cli?.bodyParams, output);
  const pathParams = objectOrEmpty(operation.cli?.pathParams);
  for (const [name, aliases] of Object.entries(pathParams)) {
    output.add(name);
    for (const alias of aliases || []) {
      output.add(String(alias));
    }
  }
  return output;
}

function normalizeResourceFieldMap(operation = {}, configuredFieldMap = {}) {
  const fields = operationFieldNames(operation);
  const output = {};
  for (const [resourceKey, aliases] of Object.entries(RESOURCE_FIELD_ALIASES)) {
    const configured = Array.isArray(configuredFieldMap[resourceKey]) ? configuredFieldMap[resourceKey] : [];
    const present = aliases.filter((alias) => fields.has(alias));
    const normalized = uniqueStrings([...configured, ...present]);
    if (normalized.length > 0) {
      output[resourceKey] = normalized;
    }
  }
  return output;
}

function inferOperationCapabilityVerb(operation = {}) {
  const idParts = String(operation.id || "").split(".").filter(Boolean);
  const lastPart = idParts[idParts.length - 1] || "";
  if (lastPart) {
    return lastPart.replace(/_/g, "-");
  }
  return operation.readOnly === true ? "read" : "write";
}

function inferOperationEffectKind(operation = {}, safety = {}) {
  if (operation.public === true) {
    return safety.readOnly === true ? "public-read" : "public-write";
  }
  if (safety.destructive === true) {
    return "destructive";
  }
  return safety.readOnly === true ? "read" : normalizeRisk(safety.risk, "safe_write").replace(/_/g, "-");
}

function inferOperationResourceKind(operation = {}) {
  const id = String(operation.id || "");
  if (
    id.startsWith("workspace.file.") ||
    id.startsWith("agent_workspaces.file.") ||
    id.startsWith("agent_workspaces.files.")
  ) {
    return "file";
  }
  if (id.startsWith("workspace.checkpoint.")) {
    return "checkpoint";
  }
  if (id.startsWith("workspace.contribution.")) {
    return "contribution";
  }
  if (id.startsWith("agent_sessions.")) {
    return "session";
  }
  if (id.startsWith("external_services.") || id.startsWith("gateway.")) {
    return "external_service";
  }
  const feature = String(operation.feature || "").trim();
  return RESOURCE_KIND_BY_FEATURE[feature] || feature || id.split(".").filter(Boolean)[0] || "operation";
}

function normalizeResourceContext(operation = {}, safety = {}) {
  const feature = String(operation.feature || "").trim();
  const idPrefix = String(operation.id || "").split(".").filter(Boolean)[0] || "operation";
  const resourceContext = compactResourceContext(operation.resourceContext);
  const resource = compactResourceContext(operation.resource);
  const fieldMap = normalizeResourceFieldMap(operation, {
    ...objectOrEmpty(resourceContext.fieldMap),
    ...objectOrEmpty(resource.fieldMap)
  });
  const inferred = {
    capabilityDomain: feature || idPrefix,
    resourceKind: inferOperationResourceKind(operation),
    capabilityVerb: inferOperationCapabilityVerb(operation),
    effectKind: inferOperationEffectKind(operation, safety)
  };
  return {
    ...inferred,
    ...resourceContext,
    ...resource,
    fieldMap
  };
}

function normalizeOperationProofPolicy(proof = {}, operation = {}) {
  const configuredProfile = String(proof.profile || "").trim();
  const excludedReason =
    proof.exclusionReason ||
    proof.reason ||
    PROOF_EXCLUDED_OPERATION_IDS.get(operation.id) ||
    "";
  if (
    configuredProfile === OPERATION_PROOF_PROFILES.EXCLUDED
  ) {
    return {
      profile: OPERATION_PROOF_PROFILES.EXCLUDED,
      exclusionReason: excludedReason
    };
  }
  if (excludedReason) {
    return {
      profile: OPERATION_PROOF_PROFILES.EXCLUDED,
      exclusionReason: excludedReason
    };
  }
  const profile = configuredProfile || (
    operation.readOnly === true || inferOperationRisk(operation) === "read_only"
      ? OPERATION_PROOF_PROFILES.RECEIPT
      : OPERATION_PROOF_PROFILES.FULL
  );
  return {
    profile,
    exclusionReason: "",
    changeProjection: String(proof.changeProjection || "").trim(),
    lifecycle: profile === OPERATION_PROOF_PROFILES.FULL ? "two-stage" : "terminal-receipt",
    substrate: "operation-proof-substrate"
  };
}

function normalizeOperationContract(operation) {
  const safety = normalizeOperationSafety(operation.safety || {}, operation);
  const publicAccess = operation.public === true || PUBLIC_OPERATION_IDS.has(operation.id);
  const externalAuth =
    operation.externalAuth === true ||
    EXTERNAL_AUTH_OPERATION_IDS.has(operation.id);
  const resourceContext = normalizeResourceContext({ ...operation, public: publicAccess }, safety);
  return {
    ...operation,
    public: publicAccess,
    externalAuth,
    externalAuthVerifier:
      operation.externalAuthVerifier ||
      EXTERNAL_AUTH_VERIFIER_DECORATORS.get(operation.id),
    externalAuthMissingCode:
      operation.externalAuthMissingCode ||
      EXTERNAL_AUTH_MISSING_CODE_DECORATORS.get(operation.id) ||
      "missing_external_auth",
    requiredScopes: Array.isArray(operation.requiredScopes) ? uniqueStrings(operation.requiredScopes) : [],
    safety,
    readOnly: safety.readOnly,
    destructive: safety.destructive,
    resource: resourceContext,
    resourceContext,
    proof: normalizeOperationProofPolicy(operation.proof || {}, { ...operation, safety, readOnly: safety.readOnly }),
    concurrencySafe:
      typeof operation.concurrencySafe === "boolean"
        ? operation.concurrencySafe
        : safety.readOnly,
    inputSchema: normalizeInputSchema(operation.inputSchema, operation),
    audit: normalizeAuditPolicy(operation.audit || {}, { ...operation, safety }),
    log: normalizeLogPolicy(operation.log || {}, { ...operation, safety })
  };
}

function validateOperation(operation, seen) {
  if (!operation.id) {
    throw new Error("Operation registration failed: missing id.");
  }
  if (!operation.target?.controller || !operation.target?.method) {
    throw new Error(`Operation registration failed: ${operation.id} missing target.`);
  }
  if (!operation.http?.method || !operation.http?.path) {
    throw new Error(`Operation registration failed: ${operation.id} missing HTTP binding.`);
  }
  if (seen.ids.has(operation.id)) {
    throw new Error(`Operation registration failed: duplicate id ${operation.id}.`);
  }
  seen.ids.add(operation.id);

  const httpKey = `${String(operation.http.method).toUpperCase()} ${operation.http.path}`;
  if (seen.http.has(httpKey)) {
    throw new Error(`Operation registration failed: duplicate HTTP binding ${httpKey}.`);
  }
  seen.http.add(httpKey);

  if (operation.rpc?.method) {
    if (seen.rpc.has(operation.rpc.method)) {
      throw new Error(`Operation registration failed: duplicate RPC method ${operation.rpc.method}.`);
    }
    seen.rpc.add(operation.rpc.method);
  }

  for (const key of ["readOnly", "destructive", "concurrencySafe"]) {
    if (typeof operation[key] !== "boolean") {
      throw new Error(`Operation registration failed: ${operation.id} missing boolean ${key}.`);
    }
  }
  if (!operation.safety?.risk) {
    throw new Error(`Operation registration failed: ${operation.id} missing safety.risk.`);
  }
  if (!Array.isArray(operation.requiredScopes)) {
    throw new Error(`Operation registration failed: ${operation.id} missing requiredScopes.`);
  }
  if (operation.requiredScopes.length === 0 && operation.public !== true && operation.externalAuth !== true) {
    throw new Error(
      `Operation registration failed: ${operation.id} has no requiredScopes and is not explicitly public/externalAuth.`
    );
  }
  if (operation.public === true && operation.externalAuth === true) {
    throw new Error(`Operation registration failed: ${operation.id} cannot be both public and externalAuth.`);
  }
  if (operation.externalAuth === true) {
    const verifier = operation.externalAuthVerifier;
    const verifierMethod = typeof verifier === "string" ? verifier : verifier?.method;
    if (!verifierMethod || typeof verifierMethod !== "string") {
      throw new Error(`Operation registration failed: ${operation.id} externalAuth missing externalAuthVerifier.method.`);
    }
  }
  if (!operation.audit || typeof operation.audit !== "object") {
    throw new Error(`Operation registration failed: ${operation.id} missing audit policy.`);
  }
  if (!operation.inputSchema || typeof operation.inputSchema !== "object") {
    throw new Error(`Operation registration failed: ${operation.id} missing inputSchema.`);
  }
  if (!operation.log || typeof operation.log !== "object" || !operation.log.redaction) {
    throw new Error(`Operation registration failed: ${operation.id} missing log redaction policy.`);
  }
  if (!operation.proof || typeof operation.proof !== "object") {
    throw new Error(`Operation registration failed: ${operation.id} missing proof profile policy.`);
  }
  if (!Object.values(OPERATION_PROOF_PROFILES).includes(operation.proof.profile)) {
    throw new Error(`Operation registration failed: ${operation.id} has invalid proof profile.`);
  }
  if (operation.proof.profile === OPERATION_PROOF_PROFILES.EXCLUDED && !operation.proof.exclusionReason) {
    throw new Error(`Operation registration failed: ${operation.id} proof exclusion missing reason.`);
  }
  if (
    [OPERATION_PROOF_PROFILES.RECEIPT, OPERATION_PROOF_PROFILES.ON_CHANGE].includes(operation.proof.profile) &&
    operation.readOnly !== true
  ) {
    throw new Error(`Operation registration failed: ${operation.id} proof profile ${operation.proof.profile} requires readOnly.`);
  }
  if (operation.proof.profile === OPERATION_PROOF_PROFILES.ON_CHANGE && !operation.proof.changeProjection) {
    throw new Error(`Operation registration failed: ${operation.id} on-change proof profile missing changeProjection.`);
  }
  if (operation.destructive && !operation.safety.blocked) {
    throw new Error(`Operation registration failed: ${operation.id} is destructive but not blocked.`);
  }
  if (!operation.readOnly && operation.audit.enabled === false) {
    throw new Error(`Operation registration failed: ${operation.id} is write-capable but audit is disabled.`);
  }
  if (riskRank(operation.safety.risk) >= riskRank("repair_write") && !operation.safety.approvalScope) {
    throw new Error(`Operation registration failed: ${operation.id} repair operation missing approvalScope.`);
  }
}

function decorateOperation(operation) {
  const scopeDecorator = REQUIRED_SCOPE_DECORATORS.has(operation.id)
    ? withRequiredScopes(REQUIRED_SCOPE_DECORATORS.get(operation.id))
    : (value) => value;
  const safetyDecorator = withSafety(SAFETY_DECORATORS.get(operation.id) || {});
  const concurrencyDecorator = CONCURRENCY_GROUP_DECORATORS.has(operation.id)
    ? withConcurrency({
        concurrencySafe: false,
        group: CONCURRENCY_GROUP_DECORATORS.get(operation.id)
      })
    : (value) => value;

  return defineOperation(
    operation,
    scopeDecorator,
    safetyDecorator,
    concurrencyDecorator,
    normalizeOperationContract,
    withAspect(OPERATION_ASPECTS.DISPATCH),
    withAspect(OPERATION_ASPECTS.AUTHORIZATION),
    withAspect(OPERATION_ASPECTS.SAFETY),
    withAspect(OPERATION_ASPECTS.AUDIT),
    withAspect(OPERATION_ASPECTS.PROOF)
  );
}

export function decorateServerApiOperations(operations = []) {
  const seen = {
    ids: new Set(),
    http: new Set(),
    rpc: new Set()
  };
  return operations.map((operation) => {
    const decorated = decorateOperation(operation);
    validateOperation(decorated, seen);
    return decorated;
  });
}

function parseJsonObject(value) {
  if (!value) {
    return {};
  }
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) {
      return {};
    }
    return parseJsonObject(value.toString("utf8"));
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getSafetyInput(context = {}) {
  return {
    ...parseJsonObject(context.requestBody),
    ...(context.params && typeof context.params === "object" ? context.params : {})
  };
}

function isTruthyFlag(value) {
  return value === true ||
    value === 1 ||
    String(value || "").trim().toLowerCase() === "true" ||
    String(value || "").trim() === "1" ||
    String(value || "").trim().toLowerCase() === "yes";
}

function hasSafetyConfirmation(context = {}) {
  const input = getSafetyInput(context);
  const safetyHeader = String(
    context.request?.headers?.["x-meshrix-safety-confirm"] ||
    context.request?.headers?.["x-meshrix-confirm"] ||
    ""
  ).trim();
  // L-3: removed URL query-param confirm path — it appears in access logs and
  // browser history.  Body and header are the only accepted confirmation signals.
  return isTruthyFlag(input.confirm) ||
    isTruthyFlag(input.safetyConfirm) ||
    isTruthyFlag(input.safety?.confirm) ||
    isTruthyFlag(safetyHeader);
}

function hasScope(session, scope) {
  if (!scope) {
    return true;
  }
  return Array.isArray(session?.user?.scopes) && session.user.scopes.includes(scope);
}

export function resolveOperationSafety(operation, context = {}) {
  const base = normalizeOperationSafety(operation.safety || {}, operation);
  const dynamicRisk = base.resolveRisk ? base.resolveRisk(context) : base.risk;
  const risk = maxRisk(base.risk, dynamicRisk);
  return normalizeOperationSafety({
    ...base,
    risk,
    requiresConfirmation:
      base.requiresConfirmationExplicit
        ? base.requiresConfirmation
        : undefined
  }, operation);
}

export function evaluateOperationSafety({
  operation,
  requestBody = Buffer.alloc(0),
  url = null,
  params = {},
  request = null,
  authSession = null,
  authEnabled = false
}) {
  const safety = resolveOperationSafety(operation, { requestBody, url, params });

  if (safety.blocked || safety.risk === "destructive") {
    return {
      ok: false,
      status: 403,
      error: `Operation ${operation.id} is registered as destructive and is blocked by policy.`,
      safety
    };
  }

  if (riskRank(safety.risk) < riskRank("repair_write")) {
    return { ok: true, safety };
  }

  if (!authEnabled) {
    // When auth is disabled, repair_write+ operations are still gated:
    // the architecture requires that no mutation, process launch, or
    // outbound request precedes its authority check.  Reject them
    // rather than silently passing.
    if (riskRank(safety.risk) >= riskRank("repair_write")) {
      return {
        ok: false,
        status: 403,
        error: `Operation ${operation.id} requires authentication for ${safety.risk} — auth is disabled.`,
        safety: { ...safety, enforcement: "auth_disabled_blocked" }
      };
    }
    return {
      ok: true,
      safety: {
        ...safety,
        enforcement: "auth_disabled"
      }
    };
  }

  if (!authSession) {
    return {
      ok: false,
      status: 401,
      error: `Operation ${operation.id} requires an authenticated approval session for ${safety.risk}.`,
      safety
    };
  }

  if (!hasScope(authSession, safety.approvalScope)) {
    return {
      ok: false,
      status: 403,
      error: `Operation ${operation.id} requires scope ${safety.approvalScope} for ${safety.risk}.`,
      safety
    };
  }

  if (safety.requiresConfirmation && !hasSafetyConfirmation({ requestBody, url, params, request })) {
    return {
      ok: false,
      status: 428,
      error: `Operation ${operation.id} requires confirm=true for ${safety.risk}.`,
      safety
    };
  }

  return { ok: true, safety };
}

export function serializableOperationSafety(operation) {
  const safety = normalizeOperationSafety(operation.safety || {}, operation);
  return {
    risk: safety.risk,
    readOnly: operation.readOnly === true || safety.readOnly === true,
    destructive: operation.destructive === true || safety.destructive === true,
    concurrencySafe: operation.concurrencySafe === true,
    approvalScope: safety.approvalScope,
    requiresConfirmation: safety.requiresConfirmation,
    blocked: safety.blocked,
    reason: safety.reason,
    dynamicRisk: typeof operation.safety?.resolveRisk === "function",
    knownRisks: MAINTENANCE_AGENT_RISKS
  };
}
