/**
 * canonical-json — Canonical JSON serialization with stable key ordering.
 *
 * Ensures deterministic output for hashing, proof chains, and diff operations.
 * Handles: sorted object keys, Date (ISO string), Buffer (base64), Map, Set,
 * undefined (null), NaN (null), Infinity (null).
 *
 * Replaces the misnamed "stableJson" which was just JSON.stringify.
 *
 * @module foundation/serialization/canonical-json
 */

import crypto from "node:crypto";
import {
  CANONICAL_JSON_VERSION,
  canonicalEqual,
  canonicalJson
} from "@lico/contracts/serialization/canonical-json";

const CANONICAL_VERSION = CANONICAL_JSON_VERSION;

/**
 * Serialize a value to canonical JSON.
 * @param {*} value - The value to serialize
 * @param {object} [options]
 * @param {boolean} [options.sorted=true] - Sort object keys recursively
 * @param {Function} [options.replacer] - Optional replacer function (applied before canonicalization)
 * @returns {string} Canonical JSON string
 */
export { canonicalJson };

/**
 * Compute a canonical hash of a value.
 * @param {*} value
 * @param {string} [algorithm='sha256']
 * @returns {string} Hex-encoded hash
 */
export function canonicalHash(value, algorithm = "sha256") {
  const json = canonicalJson(value);
  return crypto.createHash(algorithm).update(json, "utf8").digest("hex");
}

/**
 * Compute a canonical hash with prefix (for proof chains).
 * @param {*} value
 * @param {string} [algorithm='sha256']
 * @returns {string} `${algorithm}:${hex}`
 */
export function canonicalHashWithPrefix(value, algorithm = "sha256") {
  return `${algorithm}:${canonicalHash(value, algorithm)}`;
}

/**
 * Deep-equal comparison using canonical JSON.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export { canonicalEqual };

export { CANONICAL_VERSION };
