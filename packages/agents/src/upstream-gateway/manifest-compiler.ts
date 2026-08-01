import { createHash } from "node:crypto";
import { UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES } from "@meshrix/contracts/upstream-service-publishing";

const POLLUTION_KEYS: any = new Set<any>(["__proto__", "constructor", "prototype"]);

const MAX_CONTAINER_ENTRIES: any = 512;
const MAX_TOTAL_VALUES: any = 4_096;

function isRejectedCodePoint(cp?: any) : any {
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

function scanJsonStructure(raw?: any) : any {
  let offset: any = 0;
  let valueCount: any = 0;

  function fail(message?: any) : any {
    throw new SyntaxError(message);
  }

  function skipWhitespace() : any {
    while (offset < raw.length && /[\u0009\u000a\u000d\u0020]/u.test(raw[offset])) offset += 1;
  }

  function scanString() : any {
    if (raw[offset] !== '"') fail("JSON string expected.");
    const start: any = offset;
    offset += 1;
    while (offset < raw.length) {
      const character: any = raw[offset];
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
          const hex: any = raw.slice(offset + 1, offset + 5);
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

  function scanNumber() : any {
    const remaining: any = raw.slice(offset);
    const match: any = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining);
    if (!match) fail("JSON number is invalid.");
    offset += match[0].length;
  }

  function scanLiteral(literal?: any) : any {
    if (!raw.startsWith(literal, offset)) fail("JSON literal is invalid.");
    offset += literal.length;
  }

  function scanValue(depth?: any) : any {
    if (depth > 32) fail("Publishing input exceeds maximum nesting depth (32).");
    valueCount += 1;
    if (valueCount > MAX_TOTAL_VALUES) fail(`Publishing input exceeds maximum value count (${MAX_TOTAL_VALUES}).`);
    skipWhitespace();
    const character: any = raw[offset];
    if (character === "{") return scanObject(depth + 1);
    if (character === "[") return scanArray(depth + 1);
    if (character === '"') return void scanString();
    if (character === "t") return scanLiteral("true");
    if (character === "f") return scanLiteral("false");
    if (character === "n") return scanLiteral("null");
    scanNumber();
  }

  function scanObject(depth?: any) : any {
    offset += 1;
    skipWhitespace();
    const keys: any = new Set<any>();
    let memberCount: any = 0;
    if (raw[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < raw.length) {
      const key: any = scanString();
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

  function scanArray(depth?: any) : any {
    offset += 1;
    skipWhitespace();
    if (raw[offset] === "]") {
      offset += 1;
      return;
    }
    let itemCount: any = 0;
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

function parseJsonSafe(raw?: any) : any {
  const source: any = Buffer.isBuffer(raw) || raw instanceof Uint8Array
    ? new TextDecoder("utf-8", { fatal: true }).decode(raw)
    : raw;
  if (typeof source !== "string") {
    throw new TypeError("Publishing input must be UTF-8 JSON bytes or a JSON string.");
  }
  if (Buffer.byteLength(source, "utf8") > UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES) {
    throw new Error(`Publishing input exceeds ${UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES} byte limit.`);
  }
  const trimmed: any = source.trim();
  if (!trimmed) throw new SyntaxError("Publishing input must not be empty.");
  scanJsonStructure(trimmed);
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: any) {
    throw new SyntaxError(`Invalid publishing input: ${error.message}`);
  }
  rejectPollutionKeys(parsed);
  rejectUnsafeUnicodeTree(parsed);
  return parsed;
}

function rejectUnsafeUnicodeTree(value?: any) : any {
  if (typeof value === "string") {
    rejectUnsafeUnicode(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectUnsafeUnicodeTree(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of (Object.entries(value) as [string, any][])) {
      rejectUnsafeUnicode(key);
      rejectUnsafeUnicodeTree(child);
    }
  }
}

export { parseJsonSafe as parseWithDuplicateRejection };

export function rejectPollutionKeys(value?: any, path: any = "") : any {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i: any = 0; i < value.length; i++) {
      rejectPollutionKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    const keys: any = Object.keys(value);
    for (const key of keys) {
      if (POLLUTION_KEYS.has(key)) {
        throw new Error("Publishing input contains a prohibited object key.");
      }
      rejectPollutionKeys(value[key], path ? `${path}.${key}` : key);
    }
  }
}

export function canonicalSerialize(value?: any) : any {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item?: any) : any => canonicalSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys: any = Object.keys(value).sort();
    return `{${keys.map((k?: any) : any => `${JSON.stringify(k)}:${canonicalSerialize(value[k])}`).join(",")}}`;
  }
  return "null";
}

export function fingerprint(value?: any) : any {
  return createHash("sha256")
    .update(canonicalSerialize(value))
    .digest("hex");
}

export function rejectUnsafeUnicode(value?: any) : any {
  if (typeof value !== "string") return value;
  for (let i: any = 0; i < value.length; i++) {
    if (isRejectedCodePoint(value.codePointAt(i))) {
      throw new Error("Publishing input contains rejected Unicode control characters.");
    }
  }
  return value;
}
