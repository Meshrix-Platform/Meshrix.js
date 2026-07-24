import { createHash, randomUUID } from "node:crypto";

import { sendJson } from "#meshrix/foundation/http/http-response";
import { custodyPromotionAuthorizationDigest } from "#meshrix/foundation/execution-sandbox/custody-contracts";
import { PLUGIN_WORKSPACE_ACCESS_METHODS } from "./plugin-workspace-access.mjs";
import { PLUGIN_HOST_PORT_NAMES } from "./plugin-contribution-registry.mjs";
import {
  boundedCallStrings,
  canonicalPluginRequest,
  createPluginCallProjection,
  currentSandboxGovernance,
  custodyOwnerBinding,
  deepFreezeSerializable,
  isPlainObject,
  pluginTraceFacts,
  pluginWorkspaceAuthority
} from "./plugin-call-context.mjs";

const HOST_PORT_NAMES = new Set(PLUGIN_HOST_PORT_NAMES);
const PLUGIN_PERMISSION_LOAN_FIELDS = new Set([
  "loanRecordId",
  "contributionGrantId",
  "contributionId",
  "granteeId",
  "targetWorkspaceId",
  "actions",
  "expiresAt",
  "revocationPolicy",
  "createdAt",
  "workspaceId",
  "canShare",
  "canRetain"
]);
const EXTERNAL_SERVICE_REQUEST_FIELDS = new Set([
  "serviceRef",
  "operationRef",
  "input",
  "idempotencyKey",
  "timeoutMs"
]);
const EXTERNAL_SERVICE_OPTIONS_FIELDS = new Set(["signal"]);
const EXTERNAL_SERVICE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const EXTERNAL_SERVICE_MAX_REQUEST_BYTES = 1024 * 1024;
const EXTERNAL_SERVICE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function pluginPermissionGrantError(code) {
  return Object.assign(new Error("Plugin permission grant evidence was denied."), { code });
}

function boundedGrantText(value, label, { required = true, maximum = 256 } = {}) {
  const normalized = String(value || "").trim();
  if ((required && !normalized) || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw pluginPermissionGrantError(`plugin_permission_grant_${label}_invalid`);
  }
  return normalized;
}

function normalizedPluginPermissionLoan(value) {
  if (!isPlainObject(value)) throw pluginPermissionGrantError("plugin_permission_grant_record_invalid");
  if (Object.keys(value).some((field) => !PLUGIN_PERMISSION_LOAN_FIELDS.has(field))) {
    throw pluginPermissionGrantError("plugin_permission_grant_record_invalid");
  }
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 50) {
    throw pluginPermissionGrantError("plugin_permission_grant_actions_invalid");
  }
  const actions = [...new Set(value.actions.map((action) => boundedGrantText(action, "action", { maximum: 128 })))].sort();
  if (actions.length !== value.actions.length) {
    throw pluginPermissionGrantError("plugin_permission_grant_actions_invalid");
  }
  const expiresAt = boundedGrantText(value.expiresAt, "expiry", { required: false, maximum: 64 });
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw pluginPermissionGrantError("plugin_permission_grant_expiry_invalid");
  }
  const createdAt = boundedGrantText(value.createdAt, "created_at", { maximum: 64 });
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw pluginPermissionGrantError("plugin_permission_grant_created_at_invalid");
  }
  if (typeof value.canShare !== "boolean" || typeof value.canRetain !== "boolean") {
    throw pluginPermissionGrantError("plugin_permission_grant_retention_invalid");
  }
  return Object.freeze({
    loanRecordId: boundedGrantText(value.loanRecordId, "record_id"),
    contributionGrantId: boundedGrantText(value.contributionGrantId, "contribution_grant_id"),
    contributionId: boundedGrantText(value.contributionId, "contribution_id"),
    granteeId: boundedGrantText(value.granteeId, "grantee_id"),
    targetWorkspaceId: boundedGrantText(value.targetWorkspaceId, "target_workspace_id"),
    actions: Object.freeze(actions),
    ...(expiresAt ? { expiresAt: new Date(Date.parse(expiresAt)).toISOString() } : {}),
    revocationPolicy: boundedGrantText(value.revocationPolicy, "revocation_policy"),
    createdAt: new Date(Date.parse(createdAt)).toISOString(),
    workspaceId: boundedGrantText(value.workspaceId, "workspace_id"),
    canShare: value.canShare,
    canRetain: value.canRetain
  });
}

function operationPermissionGrantFacade(source, record, call) {
  return Object.freeze({
    async recordPluginGrant(input = {}) {
      if (!isPlainObject(input) || Object.keys(input).some((field) => field !== "loanRecord")) {
        throw pluginPermissionGrantError("plugin_permission_grant_request_invalid");
      }
      const governance = currentSandboxGovernance(call);
      if (governance.authorized !== true || governance.current !== true || governance.revoked === true ||
          !governance.grantRef || !governance.riskDecisionRef || !governance.policyRevision ||
          !governance.authorizationContextDigest) {
        throw pluginPermissionGrantError("plugin_permission_grant_current_authorization_required");
      }
      if (typeof source?.securityPermissions?.appendLoanRecord !== "function") {
        throw pluginPermissionGrantError("plugin_permission_grant_host_unavailable");
      }
      const loanRecord = normalizedPluginPermissionLoan(input.loanRecord);
      const callProjection = createPluginCallProjection(call);
      const evidence = Object.freeze({
        schemaVersion: "v0.0.1:plugin:permission-grant-evidence-1",
        pluginId: record.pluginId,
        operationId: record.id,
        authorization: Object.freeze({
          grantDigest: createHash("sha256").update(governance.grantRef).digest("hex"),
          authorizationContextDigest: governance.authorizationContextDigest,
          riskDecisionRef: governance.riskDecisionRef,
          policyRevision: governance.policyRevision
        }),
        loanRecord
      });
      let stored;
      try {
        stored = await source.securityPermissions.appendLoanRecord(evidence, {
          subjectId: callProjection.auth.subjectRef,
          workspaceId: loanRecord.workspaceId,
          decisionId: governance.riskDecisionRef,
          receiptId: governance.authorizationContextDigest
        });
      } catch {
        throw pluginPermissionGrantError("plugin_permission_grant_host_failed");
      }
      const storedRef = boundedGrantText(stored?.loanRecordId, "host_record_id");
      return Object.freeze({
        ok: true,
        receiptId: `sha256:${createHash("sha256").update(canonicalPluginRequest({
          pluginId: record.pluginId,
          operationId: record.id,
          storedRef,
          authorizationContextDigest: governance.authorizationContextDigest
        })).digest("hex")}`
      });
    }
  });
}

function pluginExternalServiceError(code, status = 502) {
  return Object.assign(new Error("Plugin external service request failed."), {
    code,
    status
  });
}

function externalServiceJson(value, label, depth = 0) {
  if (depth > 16) throw pluginExternalServiceError("plugin_external_service_input_invalid", 400);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw pluginExternalServiceError("plugin_external_service_input_invalid", 400);
    return Object.freeze(value.map((entry) => externalServiceJson(entry, label, depth + 1)));
  }
  if (!isPlainObject(value)) throw pluginExternalServiceError("plugin_external_service_input_invalid", 400);
  const entries = Object.entries(value);
  if (entries.length > 1_000 || entries.some(([key]) => UNSAFE_JSON_KEYS.has(key))) {
    throw pluginExternalServiceError("plugin_external_service_input_invalid", 400);
  }
  return Object.freeze(Object.fromEntries(entries.map(([key, entry]) => [
    key,
    externalServiceJson(entry, label, depth + 1)
  ])));
}

function externalServicePagination(value) {
  const fields = new Set(["nextCursor", "page", "perPage"]);
  if (!isPlainObject(value) || Object.keys(value).some((field) => !fields.has(field))) {
    throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
  }
  const output = {};
  if (value.nextCursor !== undefined) {
    const nextCursor = String(value.nextCursor || "").trim();
    if (!nextCursor || nextCursor.length > 512 || /[\u0000-\u001f\u007f]/u.test(nextCursor)) {
      throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
    }
    output.nextCursor = nextCursor;
  }
  for (const field of ["page", "perPage"]) {
    if (value[field] === undefined) continue;
    const number = Number(value[field]);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
    }
    output[field] = number;
  }
  return Object.freeze(output);
}

function externalServiceRateLimit(value) {
  const fields = new Set(["remaining", "resetAt", "retryAfterMs"]);
  if (!isPlainObject(value) || Object.keys(value).some((field) => !fields.has(field))) {
    throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
  }
  const output = {};
  for (const field of ["remaining", "retryAfterMs"]) {
    if (value[field] === undefined) continue;
    const number = Number(value[field]);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
    }
    output[field] = number;
  }
  if (value.resetAt !== undefined) {
    const resetAt = String(value.resetAt || "").trim();
    if (!Number.isFinite(Date.parse(resetAt))) {
      throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
    }
    output.resetAt = new Date(Date.parse(resetAt)).toISOString();
  }
  return Object.freeze(output);
}

function externalServiceRequestFacade(source, record, call) {
  return Object.freeze({
    async request(input = {}, options = {}) {
      if (!isPlainObject(input) || Object.keys(input).some((field) => !EXTERNAL_SERVICE_REQUEST_FIELDS.has(field)) ||
          !isPlainObject(options) || Object.keys(options).some((field) => !EXTERNAL_SERVICE_OPTIONS_FIELDS.has(field))) {
        throw pluginExternalServiceError("plugin_external_service_request_invalid", 400);
      }
      const governance = currentSandboxGovernance(call);
      if (governance.authorized !== true || governance.current !== true || governance.revoked === true ||
          !governance.grantRef || !governance.riskDecisionRef || !governance.policyRevision ||
          !governance.authorizationContextDigest) {
        throw pluginExternalServiceError("plugin_external_service_current_authorization_required", 403);
      }
      if (typeof source?.requestPluginExternalService !== "function") {
        throw pluginExternalServiceError("plugin_external_service_host_unavailable", 503);
      }
      const serviceRef = String(input.serviceRef || "").trim();
      const operationRef = String(input.operationRef || "").trim();
      if (!EXTERNAL_SERVICE_REFERENCE_PATTERN.test(serviceRef) || operationRef !== record.id) {
        throw pluginExternalServiceError("plugin_external_service_binding_denied", 403);
      }
      const requestInput = externalServiceJson(input.input ?? {}, "Plugin external service input");
      if (Buffer.byteLength(canonicalPluginRequest(requestInput), "utf8") > EXTERNAL_SERVICE_MAX_REQUEST_BYTES) {
        throw pluginExternalServiceError("plugin_external_service_input_too_large", 413);
      }
      const idempotencyKey = String(input.idempotencyKey || "").trim();
      if (idempotencyKey.length > 256 || /[\u0000-\u001f\u007f]/u.test(idempotencyKey)) {
        throw pluginExternalServiceError("plugin_external_service_idempotency_invalid", 400);
      }
      const requestedTimeout = input.timeoutMs === undefined ? 0 : Number(input.timeoutMs);
      if (requestedTimeout !== 0 && (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 100 || requestedTimeout > 300_000)) {
        throw pluginExternalServiceError("plugin_external_service_timeout_invalid", 400);
      }
      const callSignal = call.signal || call.operationLock?.signal || null;
      if (options.signal !== undefined && options.signal !== callSignal) {
        throw pluginExternalServiceError("plugin_external_service_signal_invalid", 400);
      }
      const user = call.authSession?.user || {};
      const runtimeAuthorization = call.request?.__licoToolRuntimeAuthorization ||
        call.request?.__licoOperationRuntimeAuthorization ||
        {};
      const grant = runtimeAuthorization.grant || {};
      let response;
      try {
        response = await source.requestPluginExternalService({
          pluginId: record.pluginId,
          operationId: record.id,
          serviceRef,
          operationRef,
          input: requestInput,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(requestedTimeout ? { timeoutMs: requestedTimeout } : {}),
          governance: Object.freeze({
            authorizationContextDigest: governance.authorizationContextDigest,
            riskDecisionRef: governance.riskDecisionRef,
            policyRevision: governance.policyRevision
          })
        }, {
          subject: Object.freeze({
            type: String(user.type || "plugin-operation").trim(),
            subjectId: String(user.subjectId || user.userId || "").trim(),
            roleId: String(user.roleId || user.role || "").trim(),
            scopes: boundedCallStrings([...(user.scopes || []), ...(grant.scopes || [])]),
            capabilities: boundedCallStrings([...(user.capabilities || []), ...(grant.capabilities || [])]),
            dynamicCapabilities: boundedCallStrings(grant.dynamicCapabilities || grant.capabilities),
            allowedServiceIds: boundedCallStrings(grant.allowedServiceIds || grant.metadata?.allowedServiceIds),
            allowedSecretBindings: boundedCallStrings(
              grant.allowedSecretBindings || grant.metadata?.allowedSecretBindings
            )
          }),
          signal: callSignal
        });
      } catch (error) {
        const status = Number(error?.status || 0);
        const code = callSignal?.aborted === true || status === 499
          ? "plugin_external_service_cancelled"
          : status === 504
            ? "plugin_external_service_timeout"
            : status === 403
              ? "plugin_external_service_denied"
              : status === 429
                ? "plugin_external_service_rate_limited"
                : status === 404
                  ? "plugin_external_service_binding_unavailable"
                  : "plugin_external_service_request_failed";
        throw pluginExternalServiceError(code, status >= 400 && status <= 599 ? status : 502);
      }
      if (!isPlainObject(response) || typeof response.ok !== "boolean") {
        throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
      }
      const status = Number(response.status || response.statusCode || 0);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw pluginExternalServiceError("plugin_external_service_response_invalid", 502);
      }
      if (response.ok !== true) {
        return Object.freeze({
          ok: false,
          status,
          error: Object.freeze({ code: "plugin_external_service_rejected" })
        });
      }
      const data = externalServiceJson(response.data ?? null, "Plugin external service response");
      if (Buffer.byteLength(canonicalPluginRequest(data), "utf8") > EXTERNAL_SERVICE_MAX_RESPONSE_BYTES) {
        throw pluginExternalServiceError("plugin_external_service_response_too_large", 502);
      }
      const projected = {
        ok: true,
        status,
        data
      };
      if (isPlainObject(response.pagination)) {
        projected.pagination = externalServicePagination(response.pagination);
      }
      if (isPlainObject(response.rateLimit)) {
        projected.rateLimit = externalServiceRateLimit(response.rateLimit);
      }
      const sourceReceipt = String(response.receiptRef || response.auditId || "").trim();
      if (sourceReceipt) {
        projected.receiptRef = `sha256:${createHash("sha256").update(canonicalPluginRequest({
          pluginId: record.pluginId,
          operationId: record.id,
          authorizationContextDigest: governance.authorizationContextDigest,
          sourceReceipt
        })).digest("hex")}`;
      }
      return Object.freeze(projected);
    }
  });
}

function sandboxExecutionFacade(source, record, call) {
  const pluginId = record.pluginId;
  const bindRequest = (request = {}) => Object.freeze({
    ...request,
    principal: Object.freeze({
      ...custodyOwnerBinding(call),
      operationRef: String(call?.operation?.id || request?.principal?.operationRef || "").trim()
    }),
    governance: currentSandboxGovernance(call, request)
  });
  const bindOpaqueInputs = (request, opaqueInputs) => {
    const boundRequest = bindRequest(request);
    return Object.freeze({
      request: boundRequest,
      opaqueInputs: Object.freeze((Array.isArray(opaqueInputs) ? opaqueInputs : []).map((input) => Object.freeze({
        ...input,
        authorizationDigest: custodyPromotionAuthorizationDigest({
          promotionDigest: input?.promotionDigest,
          ownerBinding: boundRequest.principal,
          governance: boundRequest.governance
        })
      })))
    });
  };
  return Object.freeze({
    execute: (request, resolveInput) => source.execute(bindRequest(request), {
      resolveInput,
      currentGovernance: currentSandboxGovernance(call, request),
      pluginId
    }),
    executeConfigured: (request, resolveInput, options = {}) => source.executeConfigured(bindRequest(request), resolveInput, {
      currentGovernance: currentSandboxGovernance(call, request),
      pluginId,
      signal: options.signal || null
    }),
    executeOpaque: (request, opaqueInputs) => {
      const bound = bindOpaqueInputs(request, opaqueInputs);
      return source.executeOpaque(bound.request, bound.opaqueInputs, {
        currentGovernance: bound.request.governance,
        pluginId
      });
    },
    executeConfiguredOpaque: (request, opaqueInputs, options = {}) => {
      const bound = bindOpaqueInputs(request, opaqueInputs);
      return source.executeConfiguredOpaque(bound.request, bound.opaqueInputs, {
        currentGovernance: bound.request.governance,
        pluginId,
        signal: options.signal || null
      });
    },
    cancel: (runId) => source.cancel(runId, { pluginId }),
    getStatus: (runId) => source.getStatus(runId, { pluginId }),
    getReceipt: (runId) => source.getReceipt(runId, { pluginId }),
    resolveQuarantinedOutput: (outputHandle) => source.resolveQuarantinedOutput(outputHandle, { pluginId }),
    disposeOutput: (outputHandle, disposition) => source.disposeOutput(outputHandle, disposition, {
      pluginId,
      owningOperationReceiptDigest: createHash("sha256").update(canonicalPluginRequest({
        operationId: String(call?.operation?.id || ""),
        requestRef: pluginTraceFacts(call).requestRef,
        outputHandle: String(outputHandle || ""),
        disposition: String(disposition || ""),
        authorizationContextDigest: currentSandboxGovernance(call).authorizationContextDigest
      })).digest("hex")
    })
  });
}

const OPAQUE_INPUT_HANDLE_SCHEMA_VERSION = "v0.0.1:plugin:opaque-input-handle-1";
const OPAQUE_INPUT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_INPUT_HANDLE_PATTERN = /^custody:[A-Za-z0-9._-]{1,160}$/u;
const OPAQUE_INPUT_CHUNK_CHARACTERS = 64 * 1024;

function opaqueInputError(code) {
  const error = new Error("Plugin opaque input preprocessing failed.");
  error.code = code;
  return error;
}

function strictBase64Metrics(value, maxBytes) {
  if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0 ||
      value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw opaqueInputError("plugin_opaque_input_base64_invalid");
  }
  const tail = value.slice(-4);
  if (Buffer.from(tail, "base64").toString("base64") !== tail) {
    throw opaqueInputError("plugin_opaque_input_base64_invalid");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteCount = value.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(byteCount) || byteCount < 1 || byteCount > maxBytes) {
    throw opaqueInputError("plugin_opaque_input_size_exceeded");
  }
  return Object.freeze({
    byteCount,
    encodedTransportDigest: createHash("sha256").update(value, "ascii").digest("hex")
  });
}

async function *base64ByteSource(value) {
  for (let offset = 0; offset < value.length; offset += OPAQUE_INPUT_CHUNK_CHARACTERS) {
    const bytes = Buffer.from(value.slice(offset, offset + OPAQUE_INPUT_CHUNK_CHARACTERS), "base64");
    try {
      yield bytes;
    } finally {
      bytes.fill(0);
    }
  }
}

function opaqueSealIdempotencyKey({ record, declaration, ownerBinding, governance, metrics, metadataDigest, requestRef }) {
  const digest = createHash("sha256").update(JSON.stringify({
    schemaVersion: declaration.schemaVersion,
    operationId: record.id,
    pluginId: record.pluginId,
    sourceField: declaration.sourceField,
    targetField: declaration.targetField,
    mediaType: declaration.mediaType,
    maxBytes: declaration.maxBytes,
    encodedTransportDigest: metrics.encodedTransportDigest,
    byteCount: metrics.byteCount,
    metadataDigest,
    requestRef,
    ownerBinding,
    sandboxFacts: {
      grantRef: governance.grantRef,
      approvalRef: governance.approvalRef,
      riskDecisionRef: governance.riskDecisionRef,
      policyRevision: governance.policyRevision,
      authorized: governance.authorized === true,
      current: governance.current === true,
      revoked: governance.revoked === true
    }
  })).digest("hex");
  return `plugin-opaque-input:${digest}`;
}

async function preprocessPluginOpaqueInputs(record, input, call, custody) {
  const declarations = record.implementation.opaqueInputPreprocessing || [];
  if (declarations.length === 0) return input;
  if (!isPlainObject(input)) throw opaqueInputError("plugin_opaque_input_object_required");
  if (!custody || typeof custody.store !== "function") {
    throw opaqueInputError("plugin_opaque_input_custody_unavailable");
  }
  let ownerBinding;
  try {
    ownerBinding = custodyOwnerBinding(call);
  } catch {
    throw opaqueInputError("plugin_opaque_input_owner_binding_required");
  }
  const governance = currentSandboxGovernance(call);
  const output = { ...input };
  const newlyStored = [];
  try {
    for (const declaration of declarations) {
      if (!Object.hasOwn(output, declaration.sourceField)) {
        throw opaqueInputError("plugin_opaque_input_source_required");
      }
      if (Object.hasOwn(output, declaration.targetField)) {
        throw opaqueInputError("plugin_opaque_input_target_forbidden");
      }
      const encoded = output[declaration.sourceField];
      const metrics = strictBase64Metrics(encoded, declaration.maxBytes);
      const metadata = { ...output };
      delete metadata[declaration.sourceField];
      delete metadata[declaration.targetField];
      const metadataDigest = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
      const stored = await custody.store({
        source: base64ByteSource(encoded),
        mediaType: declaration.mediaType,
        maxBytes: declaration.maxBytes,
        idempotencyKey: opaqueSealIdempotencyKey({
          record,
          declaration,
          ownerBinding,
          governance,
          metrics,
          metadataDigest,
          requestRef: pluginTraceFacts(call).requestRef
        }),
        ownerBinding
      });
      if (stored?.replayed !== true && OPAQUE_INPUT_HANDLE_PATTERN.test(String(stored?.handle || ""))) {
        newlyStored.push(stored.handle);
      }
      if (!OPAQUE_INPUT_HANDLE_PATTERN.test(String(stored?.handle || "")) ||
          !OPAQUE_INPUT_DIGEST_PATTERN.test(String(stored?.contentDigest || "")) ||
          !OPAQUE_INPUT_DIGEST_PATTERN.test(String(stored?.envelopeDigest || "")) ||
          Number(stored.byteCount) !== metrics.byteCount) {
        throw opaqueInputError("plugin_opaque_input_custody_receipt_invalid");
      }
      delete output[declaration.sourceField];
      output[declaration.targetField] = Object.freeze({
        schemaVersion: declaration.outputSchemaVersion,
        custodyRef: stored.handle,
        contentDigest: stored.contentDigest,
        envelopeDigest: stored.envelopeDigest,
        byteCount: Number(stored.byteCount)
      });
    }
    return deepFreezeSerializable(output);
  } catch (error) {
    if (typeof custody.delete === "function") {
      await Promise.allSettled(newlyStored.map((handle) => custody.delete({
        handle,
        authorizationRef: `plugin-opaque-input-preprocessing:${record.id}`,
        ownerBinding
      })));
    }
    if (error?.code?.startsWith?.("plugin_opaque_input_")) throw error;
    throw opaqueInputError("plugin_opaque_input_custody_failed");
  }
}

function hostPathInputError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function preprocessPluginHostPathInputs(record, input, call, agentWorkspace) {
  const declarations = record.implementation.hostPathInputPreprocessing || [];
  if (declarations.length === 0) return input;
  if (!isPlainObject(input)) throw hostPathInputError("plugin_host_path_input_invalid", 400);
  if (typeof agentWorkspace?.createLocalDirectoryMountSelection !== "function") {
    throw hostPathInputError("plugin_host_path_selection_unavailable", 503);
  }
  const authority = pluginWorkspaceAuthority(call);
  const user = call.authSession?.user || {};
  if (!authority.workspaceRef) throw hostPathInputError("plugin_host_path_selection_denied", 403);
  const output = { ...input };
  for (const declaration of declarations) {
    if (declaration.kind !== "local-directory-selection" ||
        !Object.hasOwn(output, declaration.sourceField) ||
        Object.hasOwn(output, declaration.targetField)) {
      throw hostPathInputError("plugin_host_path_input_invalid", 400);
    }
    const selected = await agentWorkspace.createLocalDirectoryMountSelection({
      workspaceId: authority.workspaceRef,
      sourcePath: output[declaration.sourceField],
      actorUserId: String(user.userId || user.subjectId || "").trim(),
      userId: String(user.userId || "").trim(),
      subjectId: String(user.subjectId || "").trim(),
      username: String(user.username || "").trim(),
      roleId: String(user.roleId || user.role || "").trim(),
      scopes: boundedCallStrings(user.scopes),
      allowedWorkspaceIds: authority.authorized === true ? [authority.workspaceRef] : [],
      canAccessAll: false,
      sharingMode: "owner-bound"
    });
    if (selected?.ok !== true || !/^local-directory-selection:[a-f0-9]{32}$/u.test(String(selected.mountSelectionRef || ""))) {
      const statusCode = [400, 403, 404].includes(Number(selected?.status)) ? Number(selected.status) : 403;
      throw hostPathInputError("plugin_host_path_selection_denied", statusCode);
    }
    delete output[declaration.sourceField];
    output[declaration.targetField] = selected.mountSelectionRef;
  }
  return deepFreezeSerializable(output);
}

function opaqueArtifactCustodyFacade(source, call) {
  return Object.freeze({
    describe: (handle, input = {}) => source.describe(handle, custodyOwnerBinding(call, input)),
    delete: (input = {}) => source.delete({
      ...input,
      ownerBinding: custodyOwnerBinding(call, input)
    })
  });
}

const AGENT_WORKSPACE_HOST_METHODS = Object.freeze([
  "connectLocalDirectory",
  "listLocalDirectoryMounts",
  "listLocalDirectoryItems",
  "listWorkspaceFiles",
  "localDirectoryItemMetadata",
  "readLocalDirectoryFile",
  "downloadWorkspaceFile",
  "writeLocalDirectoryFile",
  "uploadWorkspaceFile",
  "deleteLocalDirectoryItem",
  "deleteWorkspaceFile",
  "createLocalDirectoryFolder",
  "moveLocalDirectoryItem",
  "localDirectorySyncPlan",
  "applyLocalDirectorySync",
  "restoreWorkspaceFiles",
  "getWorkspaceSandboxMutationReceipt"
]);

function agentWorkspaceFacade(source, call) {
  const authority = pluginWorkspaceAuthority(call);
  const user = call.authSession?.user || {};
  const facade = {};
  for (const name of AGENT_WORKSPACE_HOST_METHODS) {
    if (typeof source?.[name] !== "function") continue;
    facade[name] = (input = {}) => {
      const suppliedWorkspaceRef = String(input.workspaceId || input.workspaceRef || input.workspace || "").trim();
      if (authority.workspaceRef && suppliedWorkspaceRef && suppliedWorkspaceRef !== authority.workspaceRef) {
        return { ok: false, status: 403, error: "Plugin workspace authority does not match the current operation." };
      }
      return source[name]({
        ...input,
        ...(authority.workspaceRef ? { workspaceId: authority.workspaceRef } : {}),
        actorUserId: String(user.userId || user.subjectId || "").trim(),
        userId: String(user.userId || "").trim(),
        subjectId: String(user.subjectId || "").trim(),
        username: String(user.username || "").trim(),
        roleId: String(user.roleId || user.role || "").trim(),
        scopes: boundedCallStrings(user.scopes),
        allowedWorkspaceIds: authority.authorized === true && authority.workspaceRef
          ? [authority.workspaceRef]
          : [],
        canAccessAll: false,
        sharingMode: "owner-bound"
      });
    };
  }
  return Object.freeze(facade);
}

function selectHostPorts(record, hostPorts, call = {}, rawHostPorts = {}) {
  const selected = {};
  for (const port of record.implementation.requiredHostPorts) {
    if (hostPorts[port] === undefined || hostPorts[port] === null) {
      throw new Error(`Plugin operation ${record.id} requires unavailable host port ${port}.`);
    }
    selected[port] = port === "sandboxExecution"
      ? sandboxExecutionFacade(hostPorts[port], record, call)
      : port === "opaqueArtifactCustody"
        ? opaqueArtifactCustodyFacade(hostPorts[port], call)
        : port === "operationPermissionGrant"
          ? operationPermissionGrantFacade(rawHostPorts[port], record, call)
        : port === "externalService"
          ? externalServiceRequestFacade(rawHostPorts[port], record, call)
        : port === "agentWorkspace"
          ? agentWorkspaceFacade(hostPorts[port], call)
        : hostPorts[port];
  }
  return Object.freeze(selected);
}

function responseEnded(response) {
  return response?.writableEnded === true || response?.ended === true;
}

function sendExecutionResult(response, result) {
  if (responseEnded(response)) return;
  if (result === undefined) throw new Error("Plugin operation completed without a response.");
  const envelope = isPlainObject(result) && (
    Object.hasOwn(result, "statusCode") || Object.hasOwn(result, "headers") || Object.hasOwn(result, "body")
  ) ? result : { statusCode: 200, body: result };
  const statusCode = Number(envelope.statusCode || 200) || 200;
  const headers = isPlainObject(envelope.headers) ? envelope.headers : {};
  const body = envelope.body === undefined ? null : envelope.body;
  if (Buffer.isBuffer(body) || typeof body === "string") {
    response.writeHead(statusCode, headers);
    response.end(body);
    return;
  }
  for (const [name, value] of Object.entries(headers)) response.setHeader?.(name, value);
  sendJson(response, statusCode, body);
}

function methodFacade(source, methodNames) {
  const facade = {};
  for (const name of methodNames) {
    if (typeof source?.[name] === "function") facade[name] = source[name].bind(source);
  }
  return Object.freeze(facade);
}

function projectHostPort(name, value) {
  if (name === "workspaceAccess") return methodFacade(value, PLUGIN_WORKSPACE_ACCESS_METHODS);
  if (name === "securityPermissions") return methodFacade(value, ["appendLoanRecord"]);
  if (name === "securityAlertStore") return methodFacade(value, ["appendAlert"]);
  if (name === "operationPermissionPlatform") return methodFacade(value, ["registerChangeHandler"]);
  if (name === "delegatedMcpGrantBroker") return methodFacade(value, [
    "createDelegatedMcpGrant",
    "revokeDelegatedMcpGrant"
  ]);
  if (name === "processIdentity") return methodFacade(value, ["verifyClientIdentityRevocationReceipt"]);
  if (name === "agentWorkspace") return methodFacade(value, AGENT_WORKSPACE_HOST_METHODS);
  if (name === "operationPermissionGrant") return Object.freeze({});
  if (name === "externalService") return Object.freeze({});
  if (name === "sandboxExecution") return methodFacade(value, [
    "execute",
    "executeConfigured",
    "executeOpaque",
    "executeConfiguredOpaque",
    "cancel",
    "getStatus",
    "getReceipt",
    "resolveQuarantinedOutput",
    "disposeOutput"
  ]);
  if (name === "opaqueArtifactCustody") return methodFacade(value, ["store", "describe", "delete"]);
  throw new Error(`Unsupported plugin host port ${name}.`);
}

export function createPluginContributionController({
  registry,
  hostPorts = {},
  invocationAuthorizationAuthority = null
} = {}) {
  if (!registry || typeof registry.requireOperation !== "function") {
    throw new TypeError("Plugin contribution registry is required.");
  }
  for (const name of Object.keys(hostPorts)) {
    if (!HOST_PORT_NAMES.has(name)) throw new Error(`Unsupported plugin host port ${name}.`);
  }
  const ports = Object.freeze(Object.fromEntries(
    Object.entries(hostPorts).map(([name, value]) => [name, projectHostPort(name, value)])
  ));

  return Object.freeze({
    async executePluginOperation(call = {}) {
      const record = typeof registry.operations?.get === "function"
        ? registry.operations.get(call.operation?.id) || null
        : registry.requireOperation?.(call.operation?.id) || null;
      if (!record) {
        sendExecutionResult(call.response, {
          statusCode: 404,
          body: { ok: false, error: { code: "plugin_operation_unavailable", retryable: false } }
        });
        return;
      }
      const opaqueInput = await preprocessPluginOpaqueInputs(
        record,
        call.input || {},
        call,
        hostPorts.opaqueArtifactCustody
      );
      let input;
      try {
        input = await preprocessPluginHostPathInputs(record, opaqueInput, call, hostPorts.agentWorkspace);
      } catch (error) {
        if (!error?.code?.startsWith?.("plugin_host_path_")) throw error;
        sendExecutionResult(call.response, {
          statusCode: error.statusCode,
          body: { ok: false, error: { code: error.code, retryable: error.statusCode === 503 } }
        });
        return;
      }
      const host = selectHostPorts(record, ports, call, hostPorts);
      const signal = call.signal || call.operationLock?.signal || null;
      const baseProjection = createPluginCallProjection(call);
      let invocationAuthorization = "";
      if (invocationAuthorizationAuthority?.id === "PluginInvocationAuthorizationAuthority" &&
          invocationAuthorizationAuthority.hasOwner?.(record.pluginId) === true) {
        invocationAuthorization = await invocationAuthorizationAuthority.issue({
          pluginId: record.pluginId,
          operationId: String(call.operation?.id || record.id),
          targetRef: String(input.targetRef || input.targetId || input.target?.targetRef || input.target?.targetId || "").trim(),
          requestRef: baseProjection.trace?.requestRef || randomUUID(),
          sourceRequestDigest: createHash("sha256").update(canonicalPluginRequest(call.input || {})).digest("hex"),
          principal: Object.freeze({
            subjectRef: baseProjection.auth?.subjectRef || "",
            tenantRef: baseProjection.auth?.tenantRef || "",
            workspaceRef: baseProjection.auth?.workspaceRef || ""
          }),
          governance: baseProjection.governance
        });
      }
      const result = await record.implementation.execute({
        operation: call.operation,
        input,
        call: createPluginCallProjection(call, { invocationAuthorization }),
        signal,
        host
      });
      sendExecutionResult(call.response, result);
    },
    async verifyPluginExternalAuth(call = {}) {
      const record = typeof registry.operations?.get === "function"
        ? registry.operations.get(call.operation?.id) || null
        : registry.requireOperation?.(call.operation?.id) || null;
      if (!record) return { ok: false, status: 404, reasonCode: "plugin_operation_unavailable" };
      if (typeof record.implementation.verifyExternalAuth !== "function") {
        return { ok: false, status: 503, reasonCode: "plugin_external_auth_verifier_missing" };
      }
      const host = selectHostPorts(record, ports, call);
      return record.implementation.verifyExternalAuth({
        operation: call.operation,
        input: call.input || {},
        call: createPluginCallProjection(call),
        signal: call.signal || call.operationLock?.signal || null,
        host
      });
    }
  });
}
