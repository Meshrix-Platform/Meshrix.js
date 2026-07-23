const DEFAULT_SENSITIVE_BODY_FIELD_NAMES = new Set([
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
const REDACTED_VALUE = "[redacted]";

function responseTooLargeError(maxBytes, receivedBytes) {
  const error = new Error("Upstream response exceeds configured limit.");
  error.code = "upstream_response_too_large";
  error.status = 502;
  error.maxBytes = maxBytes;
  error.receivedBytes = receivedBytes;
  return error;
}

export async function readResponseBufferWithLimit(response, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Upstream response limit must be a positive safe integer.");
  }
  const declaredLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response?.body?.cancel?.().catch?.(() => {});
    throw responseTooLargeError(limit, declaredLength);
  }
  if (!response?.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limit) {
      throw responseTooLargeError(limit, buffer.byteLength);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() => {});
        throw responseTooLargeError(limit, totalBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function readAsyncBodyBufferWithLimit(body, headers, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Upstream response limit must be a positive safe integer.");
  }
  const declaredHeader = typeof headers?.get === "function"
    ? headers.get("content-length")
    : headers?.["content-length"];
  const declaredLength = Number(Array.isArray(declaredHeader) ? declaredHeader[0] : declaredHeader || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    body?.destroy?.();
    throw responseTooLargeError(limit, declaredLength);
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of body || []) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > limit) {
      body?.destroy?.();
      throw responseTooLargeError(limit, totalBytes);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

function text(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function tryParseJson(value) {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function normalizeSensitiveBodyFields(value) {
  return asArray(value)
    .map(text)
    .map((item) => item.replace(/\[(\d+|\*)\]/g, "[]").toLowerCase())
    .filter(Boolean);
}

function responseFieldPathParts(value = "") {
  const normalized = text(value)
    .replace(/^\$\.?/u, "")
    .replace(/\[(\d+|\*)\]/g, ".[]")
    .replace(/\.\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  return normalized.split(".").map(text).filter(Boolean);
}

export function normalizeResponseBodyFields(value) {
  return asArray(value)
    .map((item) => responseFieldPathParts(item).join("."))
    .filter(Boolean);
}

export function sensitiveFieldMatcher(configuredFields = []) {
  const configured = new Set(normalizeSensitiveBodyFields(configuredFields));
  return (key, pathParts = []) => {
    const normalizedKey = text(key).toLowerCase();
    const compactKey = normalizedKey.replace(/[-.\s]/g, "_");
    if (
      DEFAULT_SENSITIVE_BODY_FIELD_NAMES.has(normalizedKey) ||
      DEFAULT_SENSITIVE_BODY_FIELD_NAMES.has(compactKey)
    ) {
      return true;
    }
    const dottedPath = pathParts
      .map((part) => String(part).replace(/\[(\d+|\*)\]/g, "[]").toLowerCase())
      .join(".");
    return configured.has(normalizedKey) || configured.has(dottedPath);
  };
}

export function visitStructuredValue(value, visitor, pathParts = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitStructuredValue(item, visitor, [...pathParts, "[]"]);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    visitor(key, child, childPath);
    visitStructuredValue(child, visitor, childPath);
  }
}

export function redactStructuredValue(value, configuredFields = []) {
  const matches = sensitiveFieldMatcher(configuredFields);
  const redact = (current, pathParts = []) => {
    if (Array.isArray(current)) {
      return current.map((item) => redact(item, [...pathParts, "[]"]));
    }
    if (!current || typeof current !== "object") {
      return current;
    }
    const output = {};
    for (const [key, child] of Object.entries(current)) {
      const childPath = [...pathParts, key];
      output[key] = matches(key, childPath) ? REDACTED_VALUE : redact(child, childPath);
    }
    return output;
  };
  return redact(value);
}

function cloneStructuredValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createProjectionNode() {
  return {
    leaf: false,
    children: new Map()
  };
}

function responseProjectionTree(publicFields = []) {
  const root = createProjectionNode();
  for (const field of normalizeResponseBodyFields(publicFields)) {
    const parts = field.split(".").filter(Boolean);
    if (!parts.length) continue;
    let current = root;
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

function projectStructuredValue(value, node) {
  if (!node) return undefined;
  if (node.leaf) {
    return cloneStructuredValue(value);
  }
  if (Array.isArray(value)) {
    const itemNode = node.children.get("[]") || node;
    return value
      .map((item) => projectStructuredValue(item, itemNode))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const output = {};
  for (const [key, childNode] of node.children.entries()) {
    if (key === "[]") continue;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const projected = projectStructuredValue(value[key], childNode);
    if (projected !== undefined) {
      output[key] = projected;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

export function filterStructuredValue(value, publicFields = []) {
  const normalizedFields = normalizeResponseBodyFields(publicFields);
  if (!normalizedFields.length) {
    return value;
  }
  const projected = projectStructuredValue(value, responseProjectionTree(normalizedFields));
  return projected === undefined ? {} : projected;
}

function responseSchemaConfigured(schema = {}) {
  return Boolean(schema && typeof schema === "object" && !Array.isArray(schema) && Object.keys(schema).length > 0);
}

function responseSchemaTypeList(schema = {}) {
  const rawType = schema.type;
  if (Array.isArray(rawType)) {
    return rawType.map(text).filter(Boolean);
  }
  const type = text(rawType);
  if (type) return [type];
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

function responseSchemaValueEquals(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

function responseValueMatchesSchemaType(value, type = "") {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return Boolean(value && typeof value === "object" && !Array.isArray(value));
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function responseSchemaSubschemas(schema = {}, keyword = "") {
  const value = schema?.[keyword];
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function safeResponseSchemaPattern(pattern = "") {
  const patternText = String(pattern);
  if (patternText.length > 160) {
    return { ok: false, error: "pattern is too long" };
  }
  if (/\\[1-9]/.test(patternText) || /\(\?/.test(patternText)) {
    return { ok: false, error: "pattern uses unsupported regular expression syntax" };
  }
  if (/\([^)]*[*+][^)]*\)\s*(?:[*+?]|\{\d*,?\d*\})/.test(patternText)) {
    return { ok: false, error: "pattern uses nested quantified groups" };
  }
  try {
    return { ok: true, regex: new RegExp(patternText, "u") };
  } catch {
    return { ok: false, error: "pattern is invalid" };
  }
}

function validateResponseValueAgainstSchema({
  operationKey = "",
  schema = {},
  value,
  path = "response"
} = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: true };
  }
  const label = operationKey || "unknown";
  const types = responseSchemaTypeList(schema);
  if (types.length && !types.some((type) => responseValueMatchesSchemaType(value, type))) {
    return {
      ok: false,
      error: `Upstream operation ${label} ${path} must be ${types.join(" or ")}.`
    };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => responseSchemaValueEquals(item, value))) {
    return {
      ok: false,
      error: `Upstream operation ${label} ${path} must match the declared enum.`
    };
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !responseSchemaValueEquals(schema.const, value)) {
    return {
      ok: false,
      error: `Upstream operation ${label} ${path} must match the declared const.`
    };
  }
  for (const [index, subschema] of responseSchemaSubschemas(schema, "allOf").entries()) {
    const validation = validateResponseValueAgainstSchema({ operationKey, schema: subschema, value, path });
    if (!validation.ok) {
      return {
        ok: false,
        error: `Upstream operation ${label} ${path} must satisfy allOf[${index}]: ${validation.error}`
      };
    }
  }
  const anyOf = responseSchemaSubschemas(schema, "anyOf");
  if (anyOf.length && !anyOf.some((subschema) =>
    validateResponseValueAgainstSchema({ operationKey, schema: subschema, value, path }).ok
  )) {
    return {
      ok: false,
      error: `Upstream operation ${label} ${path} must satisfy at least one anyOf schema.`
    };
  }
  const oneOf = responseSchemaSubschemas(schema, "oneOf");
  if (oneOf.length) {
    const matchCount = oneOf.filter((subschema) =>
      validateResponseValueAgainstSchema({ operationKey, schema: subschema, value, path }).ok
    ).length;
    if (matchCount !== 1) {
      return {
        ok: false,
        error: `Upstream operation ${label} ${path} must satisfy exactly one oneOf schema.`
      };
    }
  }
  if (schema.not && typeof schema.not === "object" && !Array.isArray(schema.not)) {
    const validation = validateResponseValueAgainstSchema({ operationKey, schema: schema.not, value, path });
    if (validation.ok) {
      return {
        ok: false,
        error: `Upstream operation ${label} ${path} must not match the declared not schema.`
      };
    }
  }
  if (typeof value === "string") {
    const minLength = Number(schema.minLength);
    const maxLength = Number(schema.maxLength);
    if (Number.isFinite(minLength) && value.length < minLength) {
      return { ok: false, error: `Upstream operation ${label} ${path} is shorter than minLength.` };
    }
    if (Number.isFinite(maxLength) && value.length > maxLength) {
      return { ok: false, error: `Upstream operation ${label} ${path} exceeds maxLength.` };
    }
    if (Object.prototype.hasOwnProperty.call(schema, "pattern")) {
      const patternValidation = safeResponseSchemaPattern(schema.pattern);
      if (!patternValidation.ok) {
        return { ok: false, error: `Upstream operation ${label} ${path} uses unsupported pattern: ${patternValidation.error}.` };
      }
      if (!patternValidation.regex.test(value)) {
        return { ok: false, error: `Upstream operation ${label} ${path} must match the declared pattern.` };
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const minimum = Number(schema.minimum);
    const maximum = Number(schema.maximum);
    if (Number.isFinite(minimum) && value < minimum) {
      return { ok: false, error: `Upstream operation ${label} ${path} is below minimum.` };
    }
    if (Number.isFinite(maximum) && value > maximum) {
      return { ok: false, error: `Upstream operation ${label} ${path} exceeds maximum.` };
    }
  }
  if (Array.isArray(value)) {
    const minItems = Number(schema.minItems);
    const maxItems = Number(schema.maxItems);
    if (Number.isFinite(minItems) && value.length < minItems) {
      return { ok: false, error: `Upstream operation ${label} ${path} has fewer items than minItems.` };
    }
    if (Number.isFinite(maxItems) && value.length > maxItems) {
      return { ok: false, error: `Upstream operation ${label} ${path} has more items than maxItems.` };
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemValidation = validateResponseValueAgainstSchema({
          operationKey,
          schema: schema.items,
          value: value[index],
          path: `${path}[${index}]`
        });
        if (!itemValidation.ok) return itemValidation;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required.map(text).filter(Boolean) : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return {
          ok: false,
          error: `Upstream operation ${label} ${path} is missing required field ${key}.`
        };
      }
    }
    const minProperties = Number(schema.minProperties);
    const maxProperties = Number(schema.maxProperties);
    if (Number.isFinite(minProperties) && Object.keys(value).length < minProperties) {
      return { ok: false, error: `Upstream operation ${label} ${path} has fewer properties than minProperties.` };
    }
    if (Number.isFinite(maxProperties) && Object.keys(value).length > maxProperties) {
      return { ok: false, error: `Upstream operation ${label} ${path} has more properties than maxProperties.` };
    }
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (!propertySchema) {
        if (schema.additionalProperties === false) {
          return {
            ok: false,
            error: `Upstream operation ${label} ${path} contains undeclared field ${key}.`
          };
        }
        if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
          const additionalValidation = validateResponseValueAgainstSchema({
            operationKey,
            schema: schema.additionalProperties,
            value: child,
            path: `${path}.${key}`
          });
          if (!additionalValidation.ok) return additionalValidation;
        }
        continue;
      }
      const propertyValidation = validateResponseValueAgainstSchema({
        operationKey,
        schema: propertySchema,
        value: child,
        path: `${path}.${key}`
      });
      if (!propertyValidation.ok) return propertyValidation;
    }
  }
  return { ok: true };
}

export function validateResponseSchema(value, schema = {}, { operationKey = "" } = {}) {
  if (!responseSchemaConfigured(schema)) {
    return { ok: true };
  }
  return validateResponseValueAgainstSchema({
    operationKey,
    schema,
    value,
    path: "response"
  });
}

function responseSchemaMismatch(validationError = "") {
  return Object.assign(new Error("Upstream response does not match configured schema."), {
    status: 502,
    reasonCode: "response_schema_mismatch",
    details: {
      reasonCode: "response_schema_mismatch",
      validationError
    }
  });
}

export function responseFilteringConfigured(operation = {}) {
  return normalizeSensitiveBodyFields(operation.sensitiveBodyFields).length > 0 ||
    normalizeResponseBodyFields(operation.publicResponseFields).length > 0;
}

export function createResponseProjectionUnavailableError(validationError = "") {
  return Object.assign(new Error("Upstream response cannot be safely filtered."), {
    status: 502,
    reasonCode: "response_projection_unavailable",
    details: {
      reasonCode: "response_projection_unavailable",
      validationError
    }
  });
}

export function assertResponseBodyPolicy(contentType, buffer, operation = {}) {
  const responseSchema = object(operation.responseSchema);
  const schemaConfigured = responseSchemaConfigured(responseSchema);
  const filteringConfigured = responseFilteringConfigured(operation);
  if (!schemaConfigured && !filteringConfigured) {
    return { schemaValidated: false, projectionValidated: false };
  }
  if (!/json/i.test(contentType)) {
    const reason = "Upstream operation response content type is not JSON.";
    throw schemaConfigured
      ? responseSchemaMismatch(reason)
      : createResponseProjectionUnavailableError(reason);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    const reason = "Upstream operation response body is not valid JSON.";
    throw schemaConfigured
      ? responseSchemaMismatch(reason)
      : createResponseProjectionUnavailableError(reason);
  }
  if (schemaConfigured) {
    const validation = validateResponseSchema(parsed, responseSchema, {
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

export function applyStructuredResponsePolicy(value, operation = {}) {
  const responseSchema = object(operation.responseSchema);
  let schemaValidated = false;
  if (responseSchemaConfigured(responseSchema)) {
    const validation = validateResponseSchema(value, responseSchema, {
      operationKey: operation.operationKey
    });
    if (!validation.ok) {
      throw responseSchemaMismatch(validation.error);
    }
    schemaValidated = true;
  }
  const redacted = redactStructuredValue(value, operation.sensitiveBodyFields);
  return {
    schemaValidated,
    projectionValidated: responseFilteringConfigured(operation),
    publicValue: filterStructuredValue(redacted, operation.publicResponseFields)
  };
}

export function bodyMetadata(value, configuredFields = [], { byteLength = 0, contentType = "application/json" } = {}) {
  const parsed = value === undefined ? undefined : (typeof value === "string" ? tryParseJson(value) : value);
  const type = parsed === undefined
    ? (value === undefined ? "empty" : typeof value)
    : Array.isArray(parsed)
      ? "array"
      : parsed === null
        ? "null"
        : typeof parsed;
  let fieldCount = 0;
  let sensitiveFieldCount = 0;
  if (parsed && typeof parsed === "object") {
    const matches = sensitiveFieldMatcher(configuredFields);
    visitStructuredValue(parsed, (key, _child, pathParts) => {
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
