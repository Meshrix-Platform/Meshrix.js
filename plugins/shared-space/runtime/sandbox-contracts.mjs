import crypto from "node:crypto";

export const SANDBOX_CUSTODY_PROMOTION_SCHEMA = "v0.0.1:execution-sandbox:opaque-custody-promotion-1";

const DIGEST = /^[a-f0-9]{64}$/u;
const HANDLE = /^custody:[A-Za-z0-9._-]{1,160}$/u;

function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedText(value, label, maximum = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function digest(value, label) {
  const normalized = boundedText(value, label, 64).toLowerCase();
  if (!DIGEST.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function custodyHandle(value) {
  const normalized = boundedText(value, "custody handle", 168);
  if (!HANDLE.test(normalized)) throw new TypeError("Custody handle is invalid.");
  return normalized;
}

export function sandboxDigest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function custodyPromotionSetDigest({ files } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) {
    throw new TypeError("Custody promotion files must be a non-empty bounded array.");
  }
  const normalizedFiles = files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new TypeError(`Custody promotion file ${index} must be an object.`);
    }
    if (file.promotionSchemaVersion !== SANDBOX_CUSTODY_PROMOTION_SCHEMA) {
      throw new TypeError(`files[${index}].promotionSchemaVersion is unsupported.`);
    }
    return Object.freeze({
      path: boundedText(file.path, `files[${index}].path`, 1024),
      custodyRef: custodyHandle(file.custodyRef),
      contentDigest: digest(file.contentDigest, `files[${index}].contentDigest`),
      envelopeDigest: digest(file.envelopeDigest, `files[${index}].envelopeDigest`),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) {
    throw new TypeError("Custody promotion file paths must be unique.");
  }
  return sandboxDigest({ promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA, files: normalizedFiles });
}
