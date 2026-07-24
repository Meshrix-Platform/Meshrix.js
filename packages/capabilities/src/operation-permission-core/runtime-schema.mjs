import { isIP } from "node:net";

const compiledInputValidators = new WeakMap();
const POLICY_ONLY_INPUT_KEYS = new Set(["tagPolicy"]);

function operationInputForSchemaValidation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !POLICY_ONLY_INPUT_KEYS.has(key))
  );
}

function schemaTypeList(schema = {}) {
  const rawType = schema.type;
  if (Array.isArray(rawType)) {
    return rawType.map((type) => String(type || "").trim()).filter(Boolean);
  }
  const type = String(rawType || "").trim();
  if (type) {
    return [type];
  }
  if (schema.properties) {
    return ["object"];
  }
  if (schema.items) {
    return ["array"];
  }
  return [];
}

function jsonSchemaValueEquals(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

const SAFE_JSON_SCHEMA_PATTERN_MAX_LENGTH = 160;

function jsonSchemaSubschemas(schema = {}, keyword = "") {
  const value = schema?.[keyword];
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function validateSafeJsonSchemaPattern(pattern = "") {
  const patternText = String(pattern);
  if (patternText.length > SAFE_JSON_SCHEMA_PATTERN_MAX_LENGTH) {
    return {
      ok: false,
      error: `pattern exceeds ${SAFE_JSON_SCHEMA_PATTERN_MAX_LENGTH} characters`
    };
  }
  if (/\\[1-9]/.test(patternText)) {
    return { ok: false, error: "backreferences are not supported" };
  }
  if (/\(\?/.test(patternText)) {
    return { ok: false, error: "lookaround and advanced group syntax are not supported" };
  }
  if (/\([^)]*[*+][^)]*\)\s*(?:[*+?]|\{\d*,?\d*\})/.test(patternText)) {
    return { ok: false, error: "nested quantified groups are not supported" };
  }
  if ((patternText.match(/\.\*/g) || []).length > 1) {
    return { ok: false, error: "multiple wildcard repetitions are not supported" };
  }
  try {
    return { ok: true, regex: new RegExp(patternText, "u") };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid regular expression"
    };
  }
}

function isValidJsonSchemaDate(value = "") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
}

function isValidJsonSchemaHostname(value = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 253 || text.endsWith(".")) {
    return false;
  }
  return text.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

function stringMatchesJsonSchemaFormat(value = "", format = "") {
  const normalized = String(format || "").trim().toLowerCase();
  if (!normalized) {
    return { ok: true };
  }
  switch (normalized) {
    case "email":
      return { ok: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) };
    case "uri":
      try {
        new URL(value);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    case "url":
      try {
        const parsed = new URL(value);
        return { ok: ["http:", "https:"].includes(parsed.protocol) };
      } catch {
        return { ok: false };
      }
    case "uuid":
      return { ok: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) };
    case "date":
      return { ok: isValidJsonSchemaDate(value) };
    case "date-time":
      return {
        ok: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
          Number.isFinite(Date.parse(value))
      };
    case "time":
      return { ok: /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][01]\d:[0-5]\d)?$/.test(value) };
    case "ipv4":
      return { ok: isIP(value) === 4 };
    case "ipv6":
      return { ok: isIP(value) === 6 };
    case "hostname":
      return { ok: isValidJsonSchemaHostname(value) };
    default:
      return {
        ok: false,
        unsupported: true,
        format: normalized
      };
  }
}

function valueMatchesSchemaType(value, type = "") {
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

function validateInputValueAgainstSchema({
  operationId = "",
  schema = {},
  value,
  path = "input"
} = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: true };
  }
  const types = schemaTypeList(schema);
  if (types.length && !types.some((type) => valueMatchesSchemaType(value, type))) {
    return {
      ok: false,
      error: `Tool operation ${operationId} ${path} must be ${types.join(" or ")}.`
    };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonSchemaValueEquals(item, value))) {
    return {
      ok: false,
      error: `Tool operation ${operationId} ${path} must be one of the declared enum values.`
    };
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonSchemaValueEquals(schema.const, value)) {
    return {
      ok: false,
      error: `Tool operation ${operationId} ${path} must match the declared const value.`
    };
  }
  for (const [index, subschema] of jsonSchemaSubschemas(schema, "allOf").entries()) {
    const validation = validateInputValueAgainstSchema({
      operationId,
      schema: subschema,
      value,
      path
    });
    if (!validation.ok) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must satisfy allOf[${index}]: ${validation.error}`
      };
    }
  }
  const anyOf = jsonSchemaSubschemas(schema, "anyOf");
  if (anyOf.length) {
    const matched = anyOf.some((subschema) => validateInputValueAgainstSchema({
      operationId,
      schema: subschema,
      value,
      path
    }).ok);
    if (!matched) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must satisfy at least one anyOf schema.`
      };
    }
  }
  const oneOf = jsonSchemaSubschemas(schema, "oneOf");
  if (oneOf.length) {
    const matchCount = oneOf.filter((subschema) => validateInputValueAgainstSchema({
      operationId,
      schema: subschema,
      value,
      path
    }).ok).length;
    if (matchCount !== 1) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must satisfy exactly one oneOf schema.`
      };
    }
  }
  if (schema.not && typeof schema.not === "object" && !Array.isArray(schema.not)) {
    const validation = validateInputValueAgainstSchema({
      operationId,
      schema: schema.not,
      value,
      path
    });
    if (validation.ok) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must not match the declared not schema.`
      };
    }
  }
  if (typeof value === "string") {
    const length = value.length;
    const minLength = Number(schema.minLength);
    const maxLength = Number(schema.maxLength);
    if (Number.isFinite(minLength) && length < minLength) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must be at least ${minLength} characters.`
      };
    }
    if (Number.isFinite(maxLength) && length > maxLength) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must be at most ${maxLength} characters.`
      };
    }
    if (Object.prototype.hasOwnProperty.call(schema, "pattern")) {
      const patternValidation = validateSafeJsonSchemaPattern(schema.pattern);
      if (!patternValidation.ok) {
        return {
          ok: false,
          error: `Tool operation ${operationId} ${path} uses unsupported pattern: ${patternValidation.error}.`
        };
      }
      if (!patternValidation.regex.test(value)) {
        return {
          ok: false,
          error: `Tool operation ${operationId} ${path} must match the declared pattern.`
        };
      }
    }
    if (schema.format) {
      const formatValidation = stringMatchesJsonSchemaFormat(value, schema.format);
      if (formatValidation.unsupported) {
        return {
          ok: false,
          error: `Tool operation ${operationId} ${path} uses unsupported string format: ${formatValidation.format}.`
        };
      }
      if (!formatValidation.ok) {
        return {
          ok: false,
          error: `Tool operation ${operationId} ${path} must match format ${String(schema.format).trim()}.`
        };
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const minimum = Number(schema.minimum);
    const maximum = Number(schema.maximum);
    if (Number.isFinite(minimum) && value < minimum) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must be at least ${minimum}.`
      };
    }
    if (Number.isFinite(maximum) && value > maximum) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must be at most ${maximum}.`
      };
    }
  }
  if (Array.isArray(value)) {
    const minItems = Number(schema.minItems);
    const maxItems = Number(schema.maxItems);
    if (Number.isFinite(minItems) && value.length < minItems) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must contain at least ${minItems} items.`
      };
    }
    if (Number.isFinite(maxItems) && value.length > maxItems) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must contain at most ${maxItems} items.`
      };
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemValidation = validateInputValueAgainstSchema({
          operationId,
          schema: schema.items,
          value: value[index],
          path: `${path}[${index}]`
        });
        if (!itemValidation.ok) {
          return itemValidation;
        }
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined || value[key] === null || value[key] === "") {
        return {
          ok: false,
          error: `Tool operation ${operationId} missing required input: ${path}.${key}.`
        };
      }
    }
    const maxProperties = Number(schema.maxProperties);
    if (Number.isFinite(maxProperties) && Object.keys(value).length > maxProperties) {
      return {
        ok: false,
        error: `Tool operation ${operationId} ${path} must contain at most ${maxProperties} properties.`
      };
    }
    for (const [key, entryValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (!propertySchema) {
        if (schema.additionalProperties === false) {
          return {
            ok: false,
            error: `Tool operation ${operationId} received undeclared input: ${path}.${key}.`
          };
        }
        if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
          const additionalValidation = validateInputValueAgainstSchema({
            operationId,
            schema: schema.additionalProperties,
            value: entryValue,
            path: `${path}.${key}`
          });
          if (!additionalValidation.ok) {
            return additionalValidation;
          }
        }
        continue;
      }
      if (entryValue === undefined || entryValue === null) {
        continue;
      }
      const propertyValidation = validateInputValueAgainstSchema({
        operationId,
        schema: propertySchema,
        value: entryValue,
        path: `${path}.${key}`
      });
      if (!propertyValidation.ok) {
        return propertyValidation;
      }
    }
  }
  return { ok: true };
}

export function compileInputSchema(operation) {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("Operation schema compilation requires an operation object.");
  }
  const cached = compiledInputValidators.get(operation);
  if (cached) return cached;
  const schema = operation.inputSchema || {};
  const topLevelTypes = schemaTypeList(schema);
  const validator = (input = {}) => {
    const schemaInput = operationInputForSchemaValidation(input);
    if (topLevelTypes.length && !topLevelTypes.includes("object")) {
      return { ok: true };
    }
    if (!schemaInput || typeof schemaInput !== "object" || Array.isArray(schemaInput)) {
      return {
        ok: false,
        error: `Tool operation ${operation.id} requires object input.`
      };
    }
    for (const key of schema.required || []) {
      if (schemaInput[key] === undefined || schemaInput[key] === null || schemaInput[key] === "") {
        return {
          ok: false,
          error: `Tool operation ${operation.id} missing required input: ${key}.`
        };
      }
    }
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    if (schema.additionalProperties === false) {
      const extraKeys = Object.keys(schemaInput).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
      if (extraKeys.length) {
        return {
          ok: false,
          error: `Tool operation ${operation.id} received undeclared input: ${extraKeys.sort().join(", ")}.`
        };
      }
    }
    return validateInputValueAgainstSchema({
      operationId: operation.id,
      schema,
      value: schemaInput,
      path: "input"
    });
  };
  compiledInputValidators.set(operation, validator);
  return validator;
}

export function validateInputSchema(operation, input = {}) {
  return compileInputSchema(operation)(input);
}
