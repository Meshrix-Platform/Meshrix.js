import { createHash } from "node:crypto";
import { UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES } from "@lico/contracts/upstream-service-publishing";

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_CONTAINER_ENTRIES = 512;
const MAX_TOTAL_VALUES = 4_096;

function isRejectedCodePoint(cp) {
  return (cp >= 0x0000 && cp <= 0x0008)
    || cp === 0x000b
    || cp === 0x000c
    || (cp >= 0x000e && cp <= 0x001f)
    || cp === 0x007f
    || (cp >= 0x0080 && cp <= 0x009f)
    || cp === 0x2028
    || cp === 0x2029
    || cp === 0xfeff;
}

function scanJsonStructure(raw) {
  let offset = 0;
  let valueCount = 0;

  function fail(message) {
    throw new SyntaxError(message);
  }

  function skipWhitespace() {
    while (offset < raw.length && /[\u0009\u000a\u000d\u0020]/u.test(raw[offset])) offset += 1;
  }

  function scanString() {
    if (raw[offset] !== '"') fail("JSON string expected.");
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      const character = raw[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(raw.slice(start, offset));
        } catch {
          fail("JSON string escape is invalid.");
        }
      }
      if (character === "\\") {
        offset += 1;
        if (offset >= raw.length || !/["\\/bfnrtu]/u.test(raw[offset])) {
          fail("JSON string escape is invalid.");
        }
        if (raw[offset] === "u") {
          const hex = raw.slice(offset + 1, offset + 5);
          if (!/^[a-fA-F0-9]{4}$/u.test(hex)) fail("JSON Unicode escape is invalid.");
          offset += 4;
        }
      } else if (character.codePointAt(0) <= 0x1f) {
        fail("JSON string contains an unescaped control character.");
      }
      offset += 1;
    }
    fail("JSON string is unterminated.");
  }

  function scanNumber() {
    const remaining = raw.slice(offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining);
    if (!match) fail("JSON number is invalid.");
    offset += match[0].length;
  }

  function scanLiteral(literal) {
    if (!raw.startsWith(literal, offset)) fail("JSON literal is invalid.");
    offset += literal.length;
  }

  function scanValue(depth) {
    if (depth > 32) fail("Publishing input exceeds maximum nesting depth (32).");
    valueCount += 1;
    if (valueCount > MAX_TOTAL_VALUES) fail(`Publishing input exceeds maximum value count (${MAX_TOTAL_VALUES}).`);
    skipWhitespace();
    const character = raw[offset];
    if (character === "{") return scanObject(depth + 1);
    if (character === "[") return scanArray(depth + 1);
    if (character === '"') return void scanString();
    if (character === "t") return scanLiteral("true");
    if (character === "f") return scanLiteral("false");
    if (character === "n") return scanLiteral("null");
    scanNumber();
  }

  function scanObject(depth) {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    let memberCount = 0;
    if (raw[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < raw.length) {
      const key = scanString();
      memberCount += 1;
      if (memberCount > MAX_CONTAINER_ENTRIES) fail(`Publishing object exceeds maximum member count (${MAX_CONTAINER_ENTRIES}).`);
      if (POLLUTION_KEYS.has(key)) fail("Publishing input contains a prohibited object key.");
      if (keys.has(key)) fail("Publishing input contains a duplicate object key.");
      keys.add(key);
      skipWhitespace();
      if (raw[offset] !== ":") fail("JSON object member separator is missing.");
      offset += 1;
      scanValue(depth);
      skipWhitespace();
      if (raw[offset] === "}") {
        offset += 1;
        return;
      }
      if (raw[offset] !== ",") fail("JSON object member delimiter is missing.");
      offset += 1;
      skipWhitespace();
    }
    fail("JSON object is unterminated.");
  }

  function scanArray(depth) {
    offset += 1;
    skipWhitespace();
    if (raw[offset] === "]") {
      offset += 1;
      return;
    }
    let itemCount = 0;
    while (offset < raw.length) {
      itemCount += 1;
      if (itemCount > MAX_CONTAINER_ENTRIES) fail(`Publishing array exceeds maximum item count (${MAX_CONTAINER_ENTRIES}).`);
      scanValue(depth);
      skipWhitespace();
      if (raw[offset] === "]") {
        offset += 1;
        return;
      }
      if (raw[offset] !== ",") fail("JSON array delimiter is missing.");
      offset += 1;
      skipWhitespace();
    }
    fail("JSON array is unterminated.");
  }

  skipWhitespace();
  scanValue(0);
  skipWhitespace();
  if (offset !== raw.length) fail("Publishing input contains trailing JSON data.");
}

function parseJsonSafe(raw) {
  const source = Buffer.isBuffer(raw) || raw instanceof Uint8Array
    ? new TextDecoder("utf-8", { fatal: true }).decode(raw)
    : raw;
  if (typeof source !== "string") {
    throw new TypeError("Publishing input must be UTF-8 JSON bytes or a JSON string.");
  }
  if (Buffer.byteLength(source, "utf8") > UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES) {
    throw new Error(`Publishing input exceeds ${UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES} byte limit.`);
  }
  const trimmed = source.trim();
  if (!trimmed) throw new SyntaxError("Publishing input must not be empty.");
  scanJsonStructure(trimmed);
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new SyntaxError(`Invalid publishing input: ${error.message}`);
  }
  rejectPollutionKeys(parsed);
  rejectUnsafeUnicodeTree(parsed);
  return parsed;
}

function rejectUnsafeUnicodeTree(value) {
  if (typeof value === "string") {
    rejectUnsafeUnicode(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeUnicodeTree(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      rejectUnsafeUnicode(key);
      rejectUnsafeUnicodeTree(child);
    }
  }
}

export { parseJsonSafe as parseWithDuplicateRejection };

export function rejectPollutionKeys(value, path = "") {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      rejectPollutionKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    for (const key of keys) {
      if (POLLUTION_KEYS.has(key)) {
        throw new Error("Publishing input contains a prohibited object key.");
      }
      rejectPollutionKeys(value[key], path ? `${path}.${key}` : key);
    }
  }
}

export function canonicalSerialize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize(value[k])}`).join(",")}}`;
  }
  return "null";
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex");
}

export function rejectUnsafeUnicode(value) {
  if (typeof value !== "string") return value;
  for (let i = 0; i < value.length; i++) {
    if (isRejectedCodePoint(value.codePointAt(i))) {
      throw new Error("Publishing input contains rejected Unicode control characters.");
    }
  }
  return value;
}
