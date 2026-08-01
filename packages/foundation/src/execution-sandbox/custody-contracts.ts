import { SANDBOX_PROVIDER_CONFORMANCE_SCHEMA, sandboxDigest } from "./contracts.ts";

export const SANDBOX_CUSTODY_ENVELOPE_SCHEMA: any = "v0.0.1:execution-sandbox:opaque-custody-envelope-1";
export const SANDBOX_CUSTODY_PROMOTION_SCHEMA: any = "v0.0.1:execution-sandbox:opaque-custody-promotion-1";

const DIGEST: any = /^[a-f0-9]{64}$/u;
const HANDLE: any = /^custody:[A-Za-z0-9._-]{1,160}$/u;

function text(value?: any, label?: any, max: any = 512) : any {
  const normalized: any = String(value || "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function optionalText(value?: any, label?: any, max: any = 512) : any {
  const normalized: any = String(value || "").trim();
  if (normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded string.`);
  }
  return normalized;
}

function digest(value?: any, label?: any) : any {
  const normalized: any = text(value, label, 64).toLowerCase();
  if (!DIGEST.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return normalized;
}

export function normalizeCustodyHandle(value?: any) : any {
  const normalized: any = text(value, "custody handle", 168);
  if (!HANDLE.test(normalized)) throw new TypeError("Custody handle is invalid.");
  return normalized;
}

export function custodyPromotionSetDigest({ files }: Record<string, any> = {}) : any {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) {
    throw new TypeError("Custody promotion files must be a non-empty bounded array.");
  }
  const normalizedFiles: any = files.map((file?: any, index?: any) : any => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new TypeError(`Custody promotion file ${index} must be an object.`);
    }
    if (file.promotionSchemaVersion !== SANDBOX_CUSTODY_PROMOTION_SCHEMA) {
      throw new TypeError(`files[${index}].promotionSchemaVersion is unsupported.`);
    }
    return Object.freeze({
      path: text(file.path, `files[${index}].path`, 1024),
      custodyRef: normalizeCustodyHandle(file.custodyRef),
      contentDigest: digest(file.contentDigest, `files[${index}].contentDigest`),
      envelopeDigest: digest(file.envelopeDigest, `files[${index}].envelopeDigest`),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    });
  }).sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
  if (new Set<any>(normalizedFiles.map((file?: any) : any => file.path)).size !== normalizedFiles.length) {
    throw new TypeError("Custody promotion file paths must be unique.");
  }
  return sandboxDigest({
    promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
    files: normalizedFiles
  });
}

export function custodyPromotionAuthorizationDigest({ promotionDigest, ownerBinding, governance }: Record<string, any> = {}) : any {
  const owner: any = ownerBinding && typeof ownerBinding === "object" && !Array.isArray(ownerBinding)
    ? ownerBinding
    : {};
  const currentGovernance: any = governance && typeof governance === "object" && !Array.isArray(governance)
    ? governance
    : {};
  return sandboxDigest({
    promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
    promotionDigest: digest(promotionDigest, "promotionDigest"),
    ownerBinding: {
      subjectRef: text(owner.subjectRef, "ownerBinding.subjectRef", 256),
      tenantRef: text(owner.tenantRef, "ownerBinding.tenantRef", 256),
      workspaceRef: text(owner.workspaceRef, "ownerBinding.workspaceRef", 256)
    },
    currentGovernance: {
      grantRef: text(currentGovernance.grantRef, "governance.grantRef", 256),
      approvalRef: optionalText(currentGovernance.approvalRef, "governance.approvalRef", 256),
      riskDecisionRef: text(currentGovernance.riskDecisionRef, "governance.riskDecisionRef", 256),
      policyRevision: text(currentGovernance.policyRevision, "governance.policyRevision", 256),
      authorized: currentGovernance.authorized === true,
      current: currentGovernance.current === true,
      revoked: currentGovernance.revoked === true
    }
  });
}

export function normalizeCustodyPromotionRequest(value: Record<string, any> = {}, { now = new Date() }: Record<string, any> = {}) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Custody promotion request must be an object.");
  }
  const allowed: any = new Set<any>([
    "schemaVersion", "handle", "contentDigest", "envelopeDigest", "authorizationRef",
    "approvalRef", "policyRevision", "providerReceipt", "sandboxAvailable", "idempotencyKey",
    "subjectRef", "tenantRef", "workspaceRef"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Custody promotion request contains unsupported field ${key}.`);
  }
  if (value.schemaVersion !== SANDBOX_CUSTODY_PROMOTION_SCHEMA) {
    throw new TypeError("Custody promotion request schemaVersion is unsupported.");
  }
  if (value.sandboxAvailable !== true) throw new TypeError("Custody promotion requires a ready sandbox.");
  const receipt: any = value.providerReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("Custody promotion requires a provider conformance receipt.");
  }
  const policyRevision: any = text(value.policyRevision, "policyRevision", 256);
  const expiresAtMs: any = Date.parse(String(receipt.expiresAt || ""));
  if (
    receipt.schemaVersion !== SANDBOX_PROVIDER_CONFORMANCE_SCHEMA ||
    receipt.status !== "passed" ||
    receipt.policyRevision !== policyRevision ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now.getTime()
  ) {
    throw new TypeError("Custody promotion requires a current policy-bound provider receipt.");
  }
  return Object.freeze({
    schemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA,
    handle: normalizeCustodyHandle(value.handle),
    contentDigest: digest(value.contentDigest, "contentDigest"),
    envelopeDigest: digest(value.envelopeDigest, "envelopeDigest"),
    authorizationRef: text(value.authorizationRef, "authorizationRef", 256),
    approvalRef: optionalText(value.approvalRef, "approvalRef", 256),
    idempotencyKey: text(value.idempotencyKey, "idempotencyKey", 256),
    subjectRef: text(value.subjectRef, "subjectRef", 256),
    tenantRef: text(value.tenantRef, "tenantRef", 256),
    workspaceRef: text(value.workspaceRef, "workspaceRef", 256),
    policyRevision,
    providerReceipt: Object.freeze({
      schemaVersion: receipt.schemaVersion,
      providerId: text(receipt.providerId, "providerReceipt.providerId", 256),
      policyRevision,
      status: "passed",
      digest: digest(receipt.digest, "providerReceipt.digest"),
      expiresAt: new Date(expiresAtMs).toISOString()
    }),
    sandboxAvailable: true
  });
}
