/**
 * The one user-held recovery key.
 *
 * Locally generated 256-bit secret, displayed once as chunked lowercase
 * base32 text — never a hex dump, never persisted by the app:
 *
 *   mrk1-<5>×n   e.g. mrk1-abcde-fghij-…
 *
 * The text encodes `version(1B) | locatorLen(1B) | locator | secret(32B) |
 * sha256(payload)[0:4]`. The locator is the non-secret vault reference
 * (typically the vaultId) so a fresh install needs no other backup artifact;
 * the checksum catches transcription errors before any network contact.
 */
import { createHash, randomBytes } from "node:crypto";
import { entryError } from "../errors.ts";

export const ENTRY_RECOVERY_TEXT_PREFIX = "mrk1";
export const ENTRY_RECOVERY_SECRET_BYTES = 32;
export const ENTRY_RECOVERY_FORMAT_VERSION = 1;
const CHECKSUM_BYTES = 4;
const MAX_LOCATOR_BYTES = 120;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text.toLowerCase()) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((buffer << (8 - bits)) & 0xff) !== 0) return null;
  return new Uint8Array(bytes);
}

export interface RecoveryKeyMaterial {
  /** 32-byte high-entropy secret — the user-held key. */
  readonly secret: Uint8Array;
  /** Non-secret vault locator (usually the vaultId); empty when unassigned. */
  readonly vaultId: string;
  readonly formatVersion: number;
}

export function generateRecoveryKey(options: { vaultId?: string } = {}): RecoveryKeyMaterial {
  const vaultId = options.vaultId ?? "";
  assertLocator(vaultId);
  return Object.freeze({
    secret: new Uint8Array(randomBytes(ENTRY_RECOVERY_SECRET_BYTES)),
    vaultId,
    formatVersion: ENTRY_RECOVERY_FORMAT_VERSION
  });
}

function assertLocator(locator: string): void {
  if (Buffer.byteLength(locator, "utf8") > MAX_LOCATOR_BYTES) {
    throw entryError("recovery_key_invalid", "Recovery locator exceeds the encode limit.");
  }
}

function checksum(payload: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(payload).digest().subarray(0, CHECKSUM_BYTES));
}

/** Format the recovery text: `mrk1-` + grouped base32 (groups of 5). */
export function formatRecoveryText(key: RecoveryKeyMaterial): string {
  assertLocator(key.vaultId);
  const locator = new TextEncoder().encode(key.vaultId);
  const payload = new Uint8Array(1 + 1 + locator.byteLength + ENTRY_RECOVERY_SECRET_BYTES);
  payload[0] = ENTRY_RECOVERY_FORMAT_VERSION;
  payload[1] = locator.byteLength;
  payload.set(locator, 2);
  payload.set(key.secret, 2 + locator.byteLength);
  const body = new Uint8Array(payload.byteLength + CHECKSUM_BYTES);
  body.set(payload);
  body.set(checksum(payload), payload.byteLength);
  const encoded = base32Encode(body);
  const groups = encoded.match(/.{1,5}/gu) ?? [];
  return `${ENTRY_RECOVERY_TEXT_PREFIX}-${groups.join("-")}`;
}

/**
 * Parse recovery text back to key material. Accepts surrounding whitespace,
 * extra hyphens/spaces inside the body, and mixed case; rejects unknown
 * prefixes, versions, bad checksums and wrong lengths with
 * `recovery_key_invalid`.
 */
export function parseRecoveryText(text: unknown): RecoveryKeyMaterial {
  if (typeof text !== "string") {
    throw entryError("recovery_key_invalid", "Recovery text must be a string.");
  }
  const trimmed = text.trim().toLowerCase();
  const bodyStart = trimmed.startsWith(`${ENTRY_RECOVERY_TEXT_PREFIX}-`)
    ? trimmed.slice(ENTRY_RECOVERY_TEXT_PREFIX.length + 1)
    : trimmed.startsWith(ENTRY_RECOVERY_TEXT_PREFIX)
      ? trimmed.slice(ENTRY_RECOVERY_TEXT_PREFIX.length)
      : null;
  if (bodyStart === null) {
    throw entryError("recovery_key_invalid", `Recovery text must begin with "${ENTRY_RECOVERY_TEXT_PREFIX}-".`);
  }
  const compact = bodyStart.replace(/[-\s]/gu, "");
  if (!compact || !/^[a-z2-7]+$/u.test(compact)) {
    throw entryError("recovery_key_invalid", "Recovery text contains invalid characters.");
  }
  const decoded = base32Decode(compact);
  if (!decoded || decoded.byteLength < 1 + 1 + ENTRY_RECOVERY_SECRET_BYTES + CHECKSUM_BYTES) {
    throw entryError("recovery_key_invalid", "Recovery text is too short or malformed.");
  }
  const payload = decoded.subarray(0, decoded.byteLength - CHECKSUM_BYTES);
  const expected = checksum(payload);
  const actual = decoded.subarray(decoded.byteLength - CHECKSUM_BYTES);
  if (Buffer.compare(Buffer.from(expected), Buffer.from(actual)) !== 0) {
    throw entryError("recovery_key_invalid", "Recovery text checksum mismatch — the key was mistyped.");
  }
  if (payload[0] !== ENTRY_RECOVERY_FORMAT_VERSION) {
    throw entryError("recovery_key_invalid", `Unsupported recovery format version ${payload[0]}.`);
  }
  const locatorLength = payload[1];
  if (2 + locatorLength + ENTRY_RECOVERY_SECRET_BYTES !== payload.byteLength) {
    throw entryError("recovery_key_invalid", "Recovery text has a malformed locator or secret length.");
  }
  return Object.freeze({
    secret: new Uint8Array(payload.subarray(2 + locatorLength)),
    vaultId: new TextDecoder().decode(payload.subarray(2, 2 + locatorLength)),
    formatVersion: payload[0]
  });
}
