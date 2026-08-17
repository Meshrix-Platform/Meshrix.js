import crypto from "node:crypto";

export const STORAGE_RECEIPT_SCHEMA = "meshrix.storage.receipt";

export type StorageReceiptStatus = "verified" | "applied" | "not_configured" | "cancelled" | "failed" | "replayed";

export interface StorageReceiptInput {
  kind?: unknown;
  status?: unknown;
  receiptId?: unknown;
  generatedAt?: unknown;
  counts?: unknown;
  revisions?: unknown;
  digestPrefixes?: unknown;
  references?: unknown;
  reasonCode?: unknown;
}

export interface StorageReceipt {
  schema: typeof STORAGE_RECEIPT_SCHEMA;
  kind: string;
  status: StorageReceiptStatus;
  receiptId: string;
  generatedAt: string;
  redacted: true;
  rawPayloadIncluded: false;
  reasonCode: string;
  counts: Readonly<Record<string, number>>;
  revisions: Readonly<Record<string, number>>;
  digestPrefixes: Readonly<Record<string, string>>;
  references: Readonly<Record<string, string>>;
}

type StorageEvidenceError = Error & { code: string; reasonCode: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_STATUS = new Set<StorageReceiptStatus>(["verified", "applied", "not_configured", "cancelled", "failed", "replayed"]);
const UNSAFE_KEY = /(path|file(?:name)?|label|secret|token|credential|certificate|private.?key|trust.?anchor|ciphertext|payload|request|endpoint|host|environment)/iu;
const UNSAFE_VALUE = /(?:\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\|Bearer\s+\S+|\bsk-[A-Za-z0-9._-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const SAFE_EVIDENCE_KEYS = new Set(["rawPayloadIncluded", "files"]);

function receiptError(code: string, message: string): StorageEvidenceError {
  const error = new Error(message) as StorageEvidenceError;
  error.name = "StorageEvidenceError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function safeId(value: unknown, field: string, { optional = true }: { optional?: boolean } = {}): string {
  const text = String(value || "");
  if (!text && optional) return "";
  if (!SAFE_ID.test(text)) {
    throw receiptError("storage_receipt_invalid", `${field} is not a valid opaque identifier.`);
  }
  return text;
}

function safeInteger(value: unknown, field: string): number {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw receiptError("storage_receipt_invalid", `${field} must be a non-negative safe integer.`);
  }
  return number;
}

function safeDigestPrefix(value: unknown): string {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (!/^[a-f0-9]{12,16}$/u.test(text)) {
    throw receiptError("storage_receipt_invalid", "Digest evidence must be a 12-16 character prefix.");
  }
  return text;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sanitizeIntegerMap(value: unknown, field: string): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(Object.entries(recordOrEmpty(value)).map(([key, entry]) => [
    safeId(key, `${field} key`, { optional: false }),
    safeInteger(entry, `${field}.${key}`)
  ])));
}

function sanitizeReferenceMap(value: unknown): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(recordOrEmpty(value)).map(([key, entry]) => [
    safeId(key, "reference key", { optional: false }),
    safeId(entry, `references.${key}`)
  ]).filter(([, entry]) => Boolean(entry))));
}

export function assertPrivacySafeStorageEvidence(value?: unknown): true {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      if (UNSAFE_KEY.test(key) && !SAFE_EVIDENCE_KEYS.has(key)) {
        throw receiptError("storage_receipt_privacy_violation", "Storage receipt contains a prohibited field.");
      }
      visit(item);
    }
  };
  visit(value);
  if (UNSAFE_VALUE.test(String(JSON.stringify(value)))) {
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
}: StorageReceiptInput = {}): Readonly<StorageReceipt> {
  const selectedKind = safeId(kind, "kind", { optional: false });
  const selectedStatus = String(status || "");
  if (!SAFE_STATUS.has(selectedStatus as StorageReceiptStatus)) {
    throw receiptError("storage_receipt_invalid", "Storage receipt status is not supported.");
  }
  const selectedGeneratedAt = String(generatedAt);
  if (!Number.isFinite(Date.parse(selectedGeneratedAt))) {
    throw receiptError("storage_receipt_invalid", "Storage receipt generatedAt is invalid.");
  }
  const receipt: Readonly<StorageReceipt> = Object.freeze({
    schema: STORAGE_RECEIPT_SCHEMA,
    kind: selectedKind,
    status: selectedStatus as StorageReceiptStatus,
    receiptId: safeId(receiptId, "receiptId", { optional: false }),
    generatedAt: new Date(selectedGeneratedAt).toISOString(),
    redacted: true,
    rawPayloadIncluded: false,
    reasonCode: safeId(reasonCode, "reasonCode"),
    counts: sanitizeIntegerMap(counts, "counts"),
    revisions: sanitizeIntegerMap(revisions, "revisions"),
    digestPrefixes: Object.freeze(Object.fromEntries(Object.entries(recordOrEmpty(digestPrefixes)).map(([key, entry]) => [
      safeId(key, "digest prefix key", { optional: false }),
      safeDigestPrefix(entry)
    ]).filter(([, entry]) => Boolean(entry)))),
    references: sanitizeReferenceMap(references)
  });
  assertPrivacySafeStorageEvidence(receipt);
  return receipt;
}
