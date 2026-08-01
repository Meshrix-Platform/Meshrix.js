import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

const PERMIT_PREFIX: any = "mxp_";
const DEFAULT_TTL_MS: any = 15_000;
const MAX_ACTIVE_PERMITS: any = 4_096;
const MAX_PROOF_REF_BYTES: any = 256;
const PROOF_REF_DIGEST_SCHEMA: any =
  "v0.0.1:security:governed-execution-proof-reference-1";
const activePermits: any = new Map<any, any>();
const consumedReceipts: any = new WeakSet<object>();

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value?: any) : any {
  return sha256(canonicalJson(value));
}

function proofReferenceDigest(value?: any) : any {
  if (typeof value !== "string") {
    deny(
      "governed_execution_permit_proof_ref_invalid",
      "Governed execution permit proof reference is invalid."
    );
  }
  const exactValue: any = value;
  if (
    exactValue.length === 0 ||
    Buffer.byteLength(exactValue, "utf8") > MAX_PROOF_REF_BYTES ||
    /[\p{Cc}\p{Cf}]/u.test(exactValue)
  ) {
    deny(
      "governed_execution_permit_proof_ref_invalid",
      "Governed execution permit proof reference is invalid."
    );
  }
  return `sha256:${canonicalDigest({
    schemaVersion: PROOF_REF_DIGEST_SCHEMA,
    proofRef: exactValue
  })}`;
}

function deny(code?: any, message?: any) : any {
  throw Object.assign(new Error(message), { code, statusCode: 403 });
}

function purgeExpired(now: any = Date.now()) : any {
  for (const [permitDigest, binding] of activePermits) {
    if (binding.expiresAt <= now) activePermits.delete(permitDigest);
  }
  while (activePermits.size >= MAX_ACTIVE_PERMITS) {
    activePermits.delete(activePermits.keys().next().value);
  }
}

export function digestGovernedExecutionRequest({
  operationId,
  transport,
  method,
  path = "",
  input = {},
  requestBody = Buffer.alloc(0)
}: Record<string, any> = {}) : any {
  const body: any = Buffer.isBuffer(requestBody)
    ? requestBody
    : Buffer.from(
        typeof requestBody === "string"
          ? requestBody
          : canonicalJson(requestBody ?? null)
      );
  return canonicalDigest({
    schemaVersion: "v0.0.1:security:governed-execution-request-binding-1",
    operationId: text(operationId),
    transport: text(transport),
    method: text(method).toUpperCase(),
    path: text(path),
    inputDigest: canonicalDigest(input ?? null),
    bodySha256: sha256(body),
    bodyBytes: body.length
  });
}

export function digestGovernedExecutionPrincipal(value: Record<string, any> = {}) : any {
  return canonicalDigest({
    type: text(value.type),
    subjectId: text(value.subjectId || value.userId),
    tenantId: text(value.tenantId),
    orgId: text(value.orgId),
    grantId: text(value.grantId),
    generation: text(value.generation || value.workloadGeneration)
  });
}

export function mintGovernedExecutionPermit({
  operationId,
  audience,
  principal,
  resource,
  requestDigest,
  proofRef,
  authorization = {},
  approval = {},
  risk = {},
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now()
}: Record<string, any> = {}) : any {
  const normalizedOperationId: any = text(operationId);
  const normalizedAudience: any = text(audience);
  const normalizedRequestDigest: any = text(requestDigest);
  const proofRefDigest: any = proofReferenceDigest(proofRef);
  if (!normalizedOperationId || !normalizedAudience || !normalizedRequestDigest) {
    deny("governed_execution_permit_binding_incomplete", "Governed execution permit binding is incomplete.");
  }
  const lifetime: any = Math.min(DEFAULT_TTL_MS, Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS));
  const token: any = `${PERMIT_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const permitDigest: any = sha256(token);
  purgeExpired(now);
  activePermits.set(permitDigest, Object.freeze({
    operationId: normalizedOperationId,
    audience: normalizedAudience,
    principalDigest: digestGovernedExecutionPrincipal(principal),
    resourceDigest: canonicalDigest(resource ?? null),
    requestDigest: normalizedRequestDigest,
    proofRef: proofRefDigest,
    authorizationDigest: canonicalDigest(authorization ?? null),
    approvalDigest: canonicalDigest(approval ?? null),
    riskDigest: canonicalDigest(risk ?? null),
    expiresAt: now + lifetime
  }));
  return token;
}

export function consumeGovernedExecutionPermit(token?: any, expected: Record<string, any> = {}, now: any = Date.now()) : any {
  const normalizedToken: any = text(token);
  if (!normalizedToken.startsWith(PERMIT_PREFIX)) {
    deny("governed_execution_permit_invalid", "Governed execution permit is invalid.");
  }
  const permitDigest: any = sha256(normalizedToken);
  const binding: any = activePermits.get(permitDigest);
  activePermits.delete(permitDigest);
  if (!binding) deny("governed_execution_permit_unknown_or_replayed", "Governed execution permit is unknown or already consumed.");
  if (binding.expiresAt <= now) deny("governed_execution_permit_expired", "Governed execution permit expired.");
  for (const [field, value] of [
    ["operationId", text(expected.operationId)],
    ["audience", text(expected.audience)],
    ["requestDigest", text(expected.requestDigest)]
  ]) {
    if (!value || binding[field] !== value) {
      deny("governed_execution_permit_binding_mismatch", "Governed execution permit binding does not match the protected sink.");
    }
  }
  if (expected.principal && binding.principalDigest !== digestGovernedExecutionPrincipal(expected.principal)) {
    deny("governed_execution_permit_principal_mismatch", "Governed execution permit principal does not match.");
  }
  if (Object.hasOwn(expected, "resource") && binding.resourceDigest !== canonicalDigest(expected.resource ?? null)) {
    deny("governed_execution_permit_resource_mismatch", "Governed execution permit resource does not match.");
  }
  const receipt: Readonly<Record<string, any>> = Object.freeze({
    schemaVersion: "v0.0.1:security:governed-execution-permit-consumption-1",
    permitDigest,
    operationId: binding.operationId,
    audience: binding.audience,
    principalDigest: binding.principalDigest,
    resourceDigest: binding.resourceDigest,
    requestDigest: binding.requestDigest,
    proofRef: binding.proofRef,
    authorizationDigest: binding.authorizationDigest,
    approvalDigest: binding.approvalDigest,
    riskDigest: binding.riskDigest,
    consumedAt: new Date(now).toISOString()
  });
  consumedReceipts.add(receipt);
  return receipt;
}

export function assertConsumedGovernedExecutionPermit(receipt?: any, expected: Record<string, any> = {}) : any {
  if (!receipt || typeof receipt !== "object" || !consumedReceipts.has(receipt)) {
    deny("governed_execution_permit_consumption_required", "A current consumed governed execution permit is required.");
  }
  if (text(expected.operationId) && receipt.operationId !== text(expected.operationId)) {
    deny("governed_execution_permit_operation_mismatch", "Consumed permit is bound to another operation.");
  }
  if (text(expected.audience) && receipt.audience !== text(expected.audience)) {
    deny("governed_execution_permit_audience_mismatch", "Consumed permit is bound to another audience.");
  }
  if (text(expected.requestDigest) && receipt.requestDigest !== text(expected.requestDigest)) {
    deny("governed_execution_permit_request_mismatch", "Consumed permit is bound to another request.");
  }
  if (expected.principal && receipt.principalDigest !== digestGovernedExecutionPrincipal(expected.principal)) {
    deny("governed_execution_permit_principal_mismatch", "Consumed permit is bound to another principal.");
  }
  return receipt;
}
