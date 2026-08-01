import crypto from "node:crypto";

export const STORAGE_RECEIPT_SCHEMA: any = "meshrix.storage.receipt";

const SAFE_ID: any = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_STATUS: any = new Set<any>(["verified", "applied", "not_configured", "cancelled", "failed", "replayed"]);
const UNSAFE_KEY: any = /(path|file(?:name)?|label|secret|token|credential|certificate|private.?key|trust.?anchor|ciphertext|payload|request|endpoint|host|environment)/iu;
const UNSAFE_VALUE: any = /(?:\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\|Bearer\s+\S+|\bsk-[A-Za-z0-9._-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const SAFE_EVIDENCE_KEYS: any = new Set<any>(["rawPayloadIncluded", "files"]);

function receiptError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.name = "StorageEvidenceError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function safeId(value?: any, field?: any, { optional = true }: Record<string, any> = {}) : any {
  const text: any = String(value || "");
  if (!text && optional) return "";
  if (!SAFE_ID.test(text)) {
    throw receiptError("storage_receipt_invalid", `${field} is not a valid opaque identifier.`);
  }
  return text;
}

function safeInteger(value?: any, field?: any) : any {
  const number: any = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw receiptError("storage_receipt_invalid", `${field} must be a non-negative safe integer.`);
  }
  return number;
}

function safeDigestPrefix(value?: any) : any {
  const text: any = String(value || "").toLowerCase();
  if (!text) return "";
  if (!/^[a-f0-9]{12,16}$/u.test(text)) {
    throw receiptError("storage_receipt_invalid", "Digest evidence must be a 12-16 character prefix.");
  }
  return text;
}

function sanitizeIntegerMap(value?: any, field?: any) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze(Object.fromEntries((Object.entries(source) as [string, any][]).map(([key, entry]: any[]) : any => [
    safeId(key, `${field} key`, { optional: false }),
    safeInteger(entry, `${field}.${key}`)
  ])));
}

function sanitizeReferenceMap(value?: any) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze(Object.fromEntries((Object.entries(source) as [string, any][]).map(([key, entry]: any[]) : any => [
    safeId(key, "reference key", { optional: false }),
    safeId(entry, `references.${key}`)
  ]).filter(([, entry]: any[]) : any => Boolean(entry))));
}

export function assertPrivacySafeStorageEvidence(value?: any) : any {
  const visit: any = (entry?: any) : any => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, item] of (Object.entries(entry) as [string, any][])) {
      if (UNSAFE_KEY.test(key) && !SAFE_EVIDENCE_KEYS.has(key)) {
        throw receiptError("storage_receipt_privacy_violation", "Storage receipt contains a prohibited field.");
      }
      visit(item);
    }
  };
  visit(value);
  if (UNSAFE_VALUE.test(JSON.stringify(value))) {
    throw receiptError("storage_receipt_privacy_violation", "Storage receipt contains prohibited local or sensitive data.");
  }
  return true;
}

export function createStorageReceipt({
  kind,
  status,
  receiptId = `storage_${crypto.randomUUID()}`,
  generatedAt = new Date().toISOString(),
  counts = {},
  revisions = {},
  digestPrefixes = {},
  references = {},
  reasonCode = ""
}: Record<string, any> = {}) : any {
  const selectedKind: any = safeId(kind, "kind", { optional: false });
  const selectedStatus: any = String(status || "");
  if (!SAFE_STATUS.has(selectedStatus)) {
    throw receiptError("storage_receipt_invalid", "Storage receipt status is not supported.");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw receiptError("storage_receipt_invalid", "Storage receipt generatedAt is invalid.");
  }
  const receipt: Readonly<Record<string, any>> = Object.freeze({
    schema: STORAGE_RECEIPT_SCHEMA,
    kind: selectedKind,
    status: selectedStatus,
    receiptId: safeId(receiptId, "receiptId", { optional: false }),
    generatedAt: new Date(generatedAt).toISOString(),
    redacted: true,
    rawPayloadIncluded: false,
    reasonCode: safeId(reasonCode, "reasonCode"),
    counts: sanitizeIntegerMap(counts, "counts"),
    revisions: sanitizeIntegerMap(revisions, "revisions"),
    digestPrefixes: Object.freeze(Object.fromEntries((Object.entries(digestPrefixes || {}) as [string, any][]).map(([key, entry]: any[]) : any => [
      safeId(key, "digest prefix key", { optional: false }),
      safeDigestPrefix(entry)
    ]).filter(([, entry]: any[]) : any => Boolean(entry)))),
    references: sanitizeReferenceMap(references)
  });
  assertPrivacySafeStorageEvidence(receipt);
  return receipt;
}
