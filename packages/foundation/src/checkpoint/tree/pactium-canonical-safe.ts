const DEFAULT_MAX_DEPTH: any = 8;
const DEFAULT_MAX_ARRAY_ITEMS: any = 100;
const DEFAULT_MAX_OBJECT_KEYS: any = 100;
const DEFAULT_MAX_STRING_LENGTH: any = 1000;

function isPlainObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeNumber(value?: any) : any {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (!Number.isSafeInteger(value)) {
    return String(value);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function toPactiumCanonicalSafeValue(value?: any, options: Record<string, any> = {}, depth: any = 0) : any {
  const maxDepth: any = Number(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxArrayItems: any = Number(options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS);
  const maxObjectKeys: any = Number(options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS);
  const maxStringLength: any = Number(options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH);
  const binaryMode: any = String(options.binaryMode || "summary");

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    const normalized: any = value.normalize("NFC");
    return normalized.length > maxStringLength
      ? `${normalized.slice(0, maxStringLength)}...`
      : normalized;
  }
  if (typeof value === "number") {
    return normalizeNumber(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (binaryMode === "preserve") {
      return Buffer.from(value);
    }
    return {
      type: Buffer.isBuffer(value) ? "buffer" : "uint8array",
      byteLength: value.length
    };
  }
  if (depth > maxDepth) {
    return "[truncated-depth]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map((item?: any) : any => toPactiumCanonicalSafeValue(item, options, depth + 1))
      .filter((item?: any) : any => item !== undefined);
  }
  if (isPlainObject(value)) {
    const output: Record<string, any> = {};
    for (const [key, nested] of (Object.entries(value) as [string, any][]).slice(0, maxObjectKeys)) {
      const safeKey: any = key === "$bytes" ? "bytes" : key;
      const cleaned: any = toPactiumCanonicalSafeValue(nested, options, depth + 1);
      if (cleaned !== undefined) {
        output[safeKey] = cleaned;
      }
    }
    return output;
  }
  return String(value);
}
