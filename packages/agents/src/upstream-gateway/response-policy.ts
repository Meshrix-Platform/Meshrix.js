import { compileClosedJsonSchema } from "@meshrix/foundation/security/closed-json-schema";

const DEFAULT_SENSITIVE_BODY_FIELD_NAMES: any = new Set<any>([
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "refresh_token",
  "refreshtoken",
  "secret",
  "token",
  "x_api_key",
  "x_auth_token"
]);
const REDACTED_VALUE: any = "[redacted]";

function responseTooLargeError(maxBytes?: any, receivedBytes?: any) : any {
  const error: Error & Record<string, any> = new Error("Upstream response exceeds configured limit.");
  error.code = "upstream_response_too_large";
  error.status = 502;
  error.maxBytes = maxBytes;
  error.receivedBytes = receivedBytes;
  return error;
}

export async function readResponseBufferWithLimit(response?: any, maxBytes?: any) : Promise<any> {
  const limit: any = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Upstream response limit must be a positive safe integer.");
  }
  const declaredLength: any = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response?.body?.cancel?.().catch?.(() : any => {});
    throw responseTooLargeError(limit, declaredLength);
  }
  if (!response?.body?.getReader) {
    const buffer: any = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limit) {
      throw responseTooLargeError(limit, buffer.byteLength);
    }
    return buffer;
  }
  const reader: any = response.body.getReader();
  const chunks: any[] = [];
  let totalBytes: any = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() : any => {});
        throw responseTooLargeError(limit, totalBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function readAsyncBodyBufferWithLimit(body?: any, headers?: any, maxBytes?: any) : Promise<any> {
  const limit: any = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Upstream response limit must be a positive safe integer.");
  }
  const declaredHeader: any = typeof headers?.get === "function"
    ? headers.get("content-length")
    : headers?.["content-length"];
  const declaredLength: any = Number(Array.isArray(declaredHeader) ? declaredHeader[0] : declaredHeader || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    body?.destroy?.();
    throw responseTooLargeError(limit, declaredLength);
  }
  const chunks: any[] = [];
  let totalBytes: any = 0;
  for await (const chunk of body || []) {
    const bytes: any = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > limit) {
      body?.destroy?.();
      throw responseTooLargeError(limit, totalBytes);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function asArray(value?: any) : any {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function tryParseJson(value?: any) : any {
  if (typeof value !== "string") return undefined;
  const raw: any = value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function normalizeSensitiveBodyFields(value?: any) : any {
  return asArray(value)
    .map(text)
    .map((item?: any) : any => item.replace(/\[(\d+|\*)\]/g, "[]").toLowerCase())
    .filter(Boolean);
}

function responseFieldPathParts(value: any = "") : any {
  const normalized: any = text(value)
    .replace(/^\$\.?/u, "")
    .replace(/\[(\d+|\*)\]/g, ".[]")
    .replace(/\.\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  return normalized.split(".").map(text).filter(Boolean);
}

export function normalizeResponseBodyFields(value?: any) : any {
  return asArray(value)
    .map((item?: any) : any => responseFieldPathParts(item).join("."))
    .filter(Boolean);
}

export function sensitiveFieldMatcher(configuredFields: any = [], { includeDefaults = true }: Record<string, any> = {}) : any {
  const configured: any = new Set<any>(normalizeSensitiveBodyFields(configuredFields));
  return (key?: any, pathParts: any = []) : any => {
    const normalizedKey: any = text(key).toLowerCase();
    const compactKey: any = normalizedKey.replace(/[-.\s]/g, "_");
    if (includeDefaults && (
      DEFAULT_SENSITIVE_BODY_FIELD_NAMES.has(normalizedKey) ||
      DEFAULT_SENSITIVE_BODY_FIELD_NAMES.has(compactKey)
    )) {
      return true;
    }
    const dottedPath: any = pathParts
      .map((part?: any) : any => String(part).replace(/\[(\d+|\*)\]/g, "[]").toLowerCase())
      .join(".");
    return configured.has(normalizedKey) || configured.has(dottedPath);
  };
}

export function visitStructuredValue(value?: any, visitor?: any, pathParts: any = []) : any {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitStructuredValue(item, visitor, [...pathParts, "[]"]);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    const childPath: any[] = [...pathParts, key];
    visitor(key, child, childPath);
    visitStructuredValue(child, visitor, childPath);
  }
}

export function redactStructuredValue(value?: any, configuredFields: any = []) : any {
  const matches: any = sensitiveFieldMatcher(configuredFields, { includeDefaults: false });
  const redact: any = (current?: any, pathParts: any = []) : any => {
    if (Array.isArray(current)) {
      return current.map((item?: any) : any => redact(item, [...pathParts, "[]"]));
    }
    if (!current || typeof current !== "object") {
      return current;
    }
    const output: Record<string, any> = {};
    for (const [key, child] of (Object.entries(current) as [string, any][])) {
      const childPath: any[] = [...pathParts, key];
      output[key] = matches(key, childPath) ? REDACTED_VALUE : redact(child, childPath);
    }
    return output;
  };
  return redact(value);
}

function cloneStructuredValue(value?: any) : any {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createProjectionNode() : any {
  return {
    leaf: false,
    children: new Map<any, any>()
  };
}

function responseProjectionTree(publicFields: any = []) : any {
  const root: any = createProjectionNode();
  for (const field of normalizeResponseBodyFields(publicFields)) {
    const parts: any = field.split(".").filter(Boolean);
    if (!parts.length) continue;
    let current: any = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        current.children.set(part, createProjectionNode());
      }
      current = current.children.get(part);
    }
    current.leaf = true;
  }
  return root;
}

function projectStructuredValue(value?: any, node?: any) : any {
  if (!node) return undefined;
  if (node.leaf) {
    return cloneStructuredValue(value);
  }
  if (Array.isArray(value)) {
    const itemNode: any = node.children.get("[]") || node;
    return value
      .map((item?: any) : any => projectStructuredValue(item, itemNode))
      .filter((item?: any) : any => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const output: Record<string, any> = {};
  for (const [key, childNode] of node.children.entries()) {
    if (key === "[]") continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const projected: any = projectStructuredValue(value[key], childNode);
    if (projected !== undefined) {
      output[key] = projected;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

export function filterStructuredValue(value?: any, publicFields: any = []) : any {
  const normalizedFields: any = normalizeResponseBodyFields(publicFields);
  if (!normalizedFields.length) {
    return value;
  }
  const projected: any = projectStructuredValue(value, responseProjectionTree(normalizedFields));
  return projected === undefined ? {} : projected;
}

export function responseSchemaConfigured(schema?: any) : any {
  if (schema === undefined) return false;
  return !(
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Object.keys(schema).length === 0
  );
}

const compiledResponseSchemas: any = new WeakMap<object, any>();

function compiledResponseSchema(schema?: any, operationKey?: any) : any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const cached: any = compiledResponseSchemas.get(schema);
  if (cached) return cached;
  const compiled: any = compileClosedJsonSchema(schema, {
    label: `Upstream operation ${operationKey || "unknown"} response schema`
  });
  compiledResponseSchemas.set(schema, compiled);
  return compiled;
}

export function validateResponseSchema(value?: any, schema: Record<string, any> = {}, { operationKey = "" }: Record<string, any> = {}) : any {
  if (!responseSchemaConfigured(schema)) return { ok: true };
  try {
    const compiled: any = compiledResponseSchema(schema, operationKey);
    if (!compiled) {
      return {
        ok: false,
        error: `Upstream operation ${operationKey || "unknown"} response schema is invalid.`
      };
    }
    const validation: any = compiled.validate(value);
    if (validation.ok) return validation;
    return {
      ok: false,
      error: `Upstream operation ${operationKey || "unknown"} ${String(
        validation.error || "response is invalid."
      ).replace(/^\$(?=\.|\s|$)/u, "response")}`
    };
  } catch {
    return {
      ok: false,
      error: `Upstream operation ${operationKey || "unknown"} response schema is invalid.`
    };
  }
}

function responseSchemaMismatch(validationError: any = "") : any {
  return Object.assign(new Error("Upstream response does not match configured schema."), {
    status: 502,
    reasonCode: "response_schema_mismatch",
    details: {
      reasonCode: "response_schema_mismatch",
      validationError
    }
  });
}

export function responseFilteringConfigured(operation: Record<string, any> = {}) : any {
  return normalizeSensitiveBodyFields(operation.sensitiveBodyFields).length > 0 ||
    normalizeResponseBodyFields(operation.publicResponseFields).length > 0;
}

export function createResponseProjectionUnavailableError(validationError: any = "") : any {
  return Object.assign(new Error("Upstream response cannot be safely filtered."), {
    status: 502,
    reasonCode: "response_projection_unavailable",
    details: {
      reasonCode: "response_projection_unavailable",
      validationError
    }
  });
}

export function assertResponseBodyPolicy(contentType?: any, buffer?: any, operation: Record<string, any> = {}) : any {
  const responseSchema: any = operation.responseSchema;
  const schemaConfigured: any = responseSchemaConfigured(responseSchema);
  const filteringConfigured: any = responseFilteringConfigured(operation);
  if (!schemaConfigured && !filteringConfigured) {
    return { schemaValidated: false, projectionValidated: false };
  }
  if (!/json/i.test(contentType)) {
    const reason: any = "Upstream operation response content type is not JSON.";
    throw schemaConfigured
      ? responseSchemaMismatch(reason)
      : createResponseProjectionUnavailableError(reason);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    const reason: any = "Upstream operation response body is not valid JSON.";
    throw schemaConfigured
      ? responseSchemaMismatch(reason)
      : createResponseProjectionUnavailableError(reason);
  }
  if (schemaConfigured) {
    const validation: any = validateResponseSchema(parsed, responseSchema, {
      operationKey: operation.operationKey
    });
    if (!validation.ok) {
      throw responseSchemaMismatch(validation.error);
    }
  }
  return {
    schemaValidated: schemaConfigured,
    projectionValidated: filteringConfigured
  };
}

export function applyStructuredResponsePolicy(value?: any, operation: Record<string, any> = {}) : any {
  const responseSchema: any = operation.responseSchema;
  let schemaValidated: any = false;
  if (responseSchemaConfigured(responseSchema)) {
    const validation: any = validateResponseSchema(value, responseSchema, {
      operationKey: operation.operationKey
    });
    if (!validation.ok) {
      throw responseSchemaMismatch(validation.error);
    }
    schemaValidated = true;
  }
  const redacted: any = redactStructuredValue(value, operation.sensitiveBodyFields);
  return {
    schemaValidated,
    projectionValidated: responseFilteringConfigured(operation),
    publicValue: filterStructuredValue(redacted, operation.publicResponseFields)
  };
}

export function bodyMetadata(value?: any, configuredFields: any = [], { byteLength = 0, contentType = "application/json" }: Record<string, any> = {}) : any {
  const parsed: any = value === undefined ? undefined : (typeof value === "string" ? tryParseJson(value) : value);
  const type: any = parsed === undefined
    ? (value === undefined ? "empty" : typeof value)
    : Array.isArray(parsed)
      ? "array"
      : parsed === null
        ? "null"
        : typeof parsed;
  let fieldCount: any = 0;
  let sensitiveFieldCount: any = 0;
  if (parsed && typeof parsed === "object") {
    const matches: any = sensitiveFieldMatcher(configuredFields);
    visitStructuredValue(parsed, (key?: any, _child?: any, pathParts?: any) : any => {
      fieldCount += 1;
      if (matches(key, pathParts)) {
        sensitiveFieldCount += 1;
      }
    });
  }
  return {
    contentType,
    byteLength,
    kind: type,
    fieldCount,
    sensitiveFieldCount,
    metadataOnly: true
  };
}
