import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

const PERMIT_PREFIX = "mxp_";
const DEFAULT_TTL_MS = 15_000;
const MAX_ACTIVE_PERMITS = 4_096;
const MAX_PROOF_REF_BYTES = 256;
const PROOF_REF_DIGEST_SCHEMA =
  "v0.0.1:security:governed-execution-proof-reference-1";
type DataRecord = Record<string, unknown>;
interface PermitBinding {
  operationId: string;
  audience: string;
  principalDigest: string;
  resourceDigest: string;
  requestDigest: string;
  proofRef: string;
  authorizationDigest: string;
  approvalDigest: string;
  riskDigest: string;
  expiresAt: number;
}
interface PermitConsumptionReceipt extends Omit<PermitBinding, "expiresAt"> {
  schemaVersion: string;
  permitDigest: string;
  consumedAt: string;
}
const activePermits = new Map<string, Readonly<PermitBinding>>();
const consumedReceipts = new WeakSet<object>();

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

function dataRecord(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRecord
    : {};
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function proofReferenceDigest(value?: unknown): string {
  if (typeof value !== "string") {
    deny(
      "governed_execution_permit_proof_ref_invalid",
      "Governed execution permit proof reference is invalid."
    );
  }
  const exactValue = value;
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

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, statusCode: 403 });
}

function purgeExpired(now = Date.now()): void {
  for (const [permitDigest, binding] of activePermits) {
    if (binding.expiresAt <= now) activePermits.delete(permitDigest);
  }
  while (activePermits.size >= MAX_ACTIVE_PERMITS) {
    const oldest = activePermits.keys().next().value;
    if (oldest === undefined) break;
    activePermits.delete(oldest);
  }
}

export function digestGovernedExecutionRequest({
  operationId,
  transport,
  method,
  path = "",
  input = {},
  requestBody = Buffer.alloc(0)
}: { operationId?: unknown; transport?: unknown; method?: unknown; path?: unknown; input?: unknown; requestBody?: unknown } = {}): string {
  const body = Buffer.isBuffer(requestBody)
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

export function digestGovernedExecutionPrincipal(value: DataRecord = {}): string {
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
}: {
  operationId?: unknown; audience?: unknown; principal?: unknown; resource?: unknown;
  requestDigest?: unknown; proofRef?: unknown; authorization?: unknown; approval?: unknown;
  risk?: unknown; ttlMs?: number; now?: number;
} = {}): string {
  const normalizedOperationId = text(operationId);
  const normalizedAudience = text(audience);
  const normalizedRequestDigest = text(requestDigest);
  const proofRefDigest = proofReferenceDigest(proofRef);
  if (!normalizedOperationId || !normalizedAudience || !normalizedRequestDigest) {
    deny("governed_execution_permit_binding_incomplete", "Governed execution permit binding is incomplete.");
  }
  const lifetime = Math.min(DEFAULT_TTL_MS, Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS));
  const token = `${PERMIT_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  const permitDigest = sha256(token);
  purgeExpired(now);
  activePermits.set(permitDigest, Object.freeze({
    operationId: normalizedOperationId,
    audience: normalizedAudience,
    principalDigest: digestGovernedExecutionPrincipal(dataRecord(principal)),
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

export function consumeGovernedExecutionPermit(token?: unknown, expected: DataRecord = {}, now = Date.now()): Readonly<PermitConsumptionReceipt> {
  const normalizedToken = text(token);
  if (!normalizedToken.startsWith(PERMIT_PREFIX)) {
    deny("governed_execution_permit_invalid", "Governed execution permit is invalid.");
  }
  const permitDigest = sha256(normalizedToken);
  const binding = activePermits.get(permitDigest);
  activePermits.delete(permitDigest);
  if (!binding) deny("governed_execution_permit_unknown_or_replayed", "Governed execution permit is unknown or already consumed.");
  if (binding.expiresAt <= now) deny("governed_execution_permit_expired", "Governed execution permit expired.");
  for (const [field, value] of [
    ["operationId", text(expected.operationId)],
    ["audience", text(expected.audience)],
    ["requestDigest", text(expected.requestDigest)]
  ] as const) {
    if (!value || binding[field] !== value) {
      deny("governed_execution_permit_binding_mismatch", "Governed execution permit binding does not match the protected sink.");
    }
  }
  if (expected.principal && binding.principalDigest !== digestGovernedExecutionPrincipal(dataRecord(expected.principal))) {
    deny("governed_execution_permit_principal_mismatch", "Governed execution permit principal does not match.");
  }
  if (Object.hasOwn(expected, "resource") && binding.resourceDigest !== canonicalDigest(expected.resource ?? null)) {
    deny("governed_execution_permit_resource_mismatch", "Governed execution permit resource does not match.");
  }
  const receipt: Readonly<PermitConsumptionReceipt> = Object.freeze({
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

export function assertConsumedGovernedExecutionPermit(receipt: Readonly<PermitConsumptionReceipt> | undefined, expected: DataRecord = {}): Readonly<PermitConsumptionReceipt> {
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
  if (expected.principal && receipt.principalDigest !== digestGovernedExecutionPrincipal(dataRecord(expected.principal))) {
    deny("governed_execution_permit_principal_mismatch", "Consumed permit is bound to another principal.");
  }
  return receipt;
}
