import { isIP } from "node:net";

const SUPPORTED_TYPES: any = new Set<any>([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
const SUPPORTED_FORMATS: any = new Set<any>([
  "date",
  "date-time",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "time",
  "uri",
  "url",
  "uuid"
]);
const SUPPORTED_KEYWORDS: any = new Set<any>([
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "enum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "type"
]);
const OBJECT_KEYWORDS: any = new Set<any>([
  "additionalProperties",
  "maxProperties",
  "minProperties",
  "properties",
  "required"
]);
const ARRAY_KEYWORDS: any = new Set<any>(["items", "maxItems", "minItems"]);
const STRING_KEYWORDS: any = new Set<any>(["format", "maxLength", "minLength", "pattern"]);
const NUMBER_KEYWORDS: any = new Set<any>(["maximum", "minimum"]);
const UNSAFE_PROPERTY_NAMES: any = new Set<any>(["__proto__", "constructor", "prototype"]);

const MAX_SCHEMA_DEPTH: any = 8;
const MAX_SCHEMA_NODES: any = 512;
const MAX_PROPERTIES_PER_SCHEMA: any = 128;
const MAX_REQUIRED_FIELDS: any = 128;
const MAX_ENUM_VALUES: any = 128;
const MAX_COMBINATOR_BRANCHES: any = 32;
const MAX_LITERAL_DEPTH: any = 16;
const MAX_LITERAL_NODES: any = 4096;
const MAX_VALUE_COLLECTION_SIZE: any = 4096;
const MAX_VALIDATION_STEPS: any = 32768;
const MAX_PATTERN_LENGTH: any = 160;
const MAX_PROPERTY_NAME_LENGTH: any = 256;

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function schemaError(label?: any, path?: any, reason?: any) : any {
  const error: any = new TypeError(`${label} ${path} ${reason}`);
  error.code = "closed_json_schema_invalid";
  return error;
}

function ownDataEntries(value?: any, label?: any, path?: any) : any {
  const keys: any = Reflect.ownKeys(value);
  if (keys.some((key?: any) : any => typeof key !== "string")) {
    throw schemaError(label, path, "contains an unsupported symbol key.");
  }
  return keys.map((key?: any) : any => {
    const descriptor: any = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw schemaError(label, path, "must contain only enumerable data properties.");
    }
    return [key, descriptor.value];
  });
}

function assertPropertyName(value?: any, label?: any, path?: any) : any {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROPERTY_NAME_LENGTH ||
    UNSAFE_PROPERTY_NAMES.has(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw schemaError(label, path, "contains an invalid property name.");
  }
  return value;
}

function cloneJsonLiteral(value?: any, state?: any, label?: any, path?: any, depth: any = 0, active: any = new WeakSet<object>()) : any {
  if (depth > MAX_LITERAL_DEPTH) {
    throw schemaError(label, path, "contains an excessively nested JSON value.");
  }
  state.literalNodes += 1;
  if (state.literalNodes > MAX_LITERAL_NODES) {
    throw schemaError(label, path, "contains too many JSON value nodes.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw schemaError(label, path, "must contain finite JSON numbers.");
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw schemaError(label, path, "must contain only JSON-compatible values.");
  }
  if (active.has(value)) {
    throw schemaError(label, path, "must not contain cycles.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_LITERAL_NODES) {
        throw schemaError(label, path, "contains an oversized JSON array.");
      }
      return Object.freeze(value.map((entry?: any, index?: any) : any =>
        cloneJsonLiteral(entry, state, label, `${path}[${index}]`, depth + 1, active)
      ));
    }
    if (!isPlainObject(value)) {
      throw schemaError(label, path, "must contain only JSON objects.");
    }
    const entries: any = ownDataEntries(value, label, path);
    if (entries.length > MAX_LITERAL_NODES) {
      throw schemaError(label, path, "contains an oversized JSON object.");
    }
    const output: Record<string, any> = {};
    for (const [key, entry] of entries) {
      assertPropertyName(key, label, path);
      output[key] = cloneJsonLiteral(entry, state, label, `${path}.${key}`, depth + 1, active);
    }
    return Object.freeze(output);
  } finally {
    active.delete(value);
  }
}

function jsonLiteralKey(value?: any) : any {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (Array.isArray(value)) {
    return `array:[${value.map(jsonLiteralKey).join(",")}]`;
  }
  return `object:{${Object.keys(value)
    .sort()
    .map((key?: any) : any => `${JSON.stringify(key)}:${jsonLiteralKey(value[key])}`)
    .join(",")}}`;
}

function readTypes(source?: any, label?: any, path?: any) : any {
  if (!Object.hasOwn(source, "type")) return [];
  const rawTypes: any = Array.isArray(source.type) ? source.type : [source.type];
  if (rawTypes.length === 0 || rawTypes.length > SUPPORTED_TYPES.size) {
    throw schemaError(label, `${path}.type`, "must declare at least one supported type.");
  }
  const types: any[] = [];
  for (const rawType of rawTypes) {
    if (typeof rawType !== "string" || !SUPPORTED_TYPES.has(rawType) || types.includes(rawType)) {
      throw schemaError(label, `${path}.type`, "contains an unsupported or duplicate type.");
    }
    types.push(rawType);
  }
  return types;
}

function inferredTypes(source?: any) : any {
  const inferred: any = new Set<any>();
  for (const keyword of Object.keys(source)) {
    if (OBJECT_KEYWORDS.has(keyword)) inferred.add("object");
    if (ARRAY_KEYWORDS.has(keyword)) inferred.add("array");
    if (STRING_KEYWORDS.has(keyword)) inferred.add("string");
    if (NUMBER_KEYWORDS.has(keyword)) inferred.add("number");
  }
  return inferred;
}

function assertKeywordTypeCompatibility(source?: any, types?: any, label?: any, path?: any) : any {
  const explicit: any = types.length > 0;
  const inferred: any = inferredTypes(source);
  if (!explicit && inferred.size > 1) {
    throw schemaError(label, path, "mixes constraints for incompatible value types.");
  }
  if (!explicit) return [...inferred];
  const supports: any = (type?: any) : any => types.includes(type) ||
    (type === "number" && types.includes("integer"));
  for (const type of inferred) {
    if (!supports(type)) {
      throw schemaError(label, path, `uses ${type} constraints without declaring that type.`);
    }
  }
  return types;
}

function readNonNegativeInteger(source?: any, keyword?: any, label?: any, path?: any) : any {
  if (!Object.hasOwn(source, keyword)) return undefined;
  const value: any = source[keyword];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw schemaError(label, `${path}.${keyword}`, "must be a non-negative safe integer.");
  }
  return value;
}

function readFiniteNumber(source?: any, keyword?: any, label?: any, path?: any) : any {
  if (!Object.hasOwn(source, keyword)) return undefined;
  const value: any = source[keyword];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw schemaError(label, `${path}.${keyword}`, "must be a finite number.");
  }
  return value;
}

function assertOrderedBounds(minimum?: any, maximum?: any, label?: any, path?: any, names?: any) : any {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw schemaError(label, path, `${names[0]} must not exceed ${names[1]}.`);
  }
}

function compileSafePattern(value?: any, label?: any, path?: any) : any {
  if (typeof value !== "string" || value.length > MAX_PATTERN_LENGTH) {
    throw schemaError(label, path, `must be a string of at most ${MAX_PATTERN_LENGTH} characters.`);
  }
  if (
    /\\[1-9]/u.test(value) ||
    /\(\?/u.test(value) ||
    /\([^)]*[*+][^)]*\)\s*(?:[*+?]|\{\d*,?\d*\})/u.test(value) ||
    (value.match(/\.\*/gu) || []).length > 1
  ) {
    throw schemaError(label, path, "uses unsupported regular-expression syntax.");
  }
  try {
    return new RegExp(value, "u");
  } catch {
    throw schemaError(label, path, "must be a valid bounded regular expression.");
  }
}

function compileBranches(source?: any, keyword?: any, context?: any, path?: any, depth?: any, inheritedProperties?: any) : any {
  if (!Object.hasOwn(source, keyword)) return [];
  const branches: any = source[keyword];
  if (
    !Array.isArray(branches) ||
    branches.length === 0 ||
    branches.length > MAX_COMBINATOR_BRANCHES
  ) {
    throw schemaError(
      context.label,
      `${path}.${keyword}`,
      `must contain between 1 and ${MAX_COMBINATOR_BRANCHES} schemas.`
    );
  }
  return branches.map((branch?: any, index?: any) : any =>
    compileSchemaNode(
      branch,
      context,
      `${path}.${keyword}[${index}]`,
      depth + 1,
      inheritedProperties
    )
  );
}

function compileSchemaNode(source?: any, context?: any, path?: any, depth?: any, inheritedProperties: any = null) : any {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw schemaError(context.label, path, "exceeds the supported nesting depth.");
  }
  if (!isPlainObject(source)) {
    throw schemaError(context.label, path, "must be a plain object.");
  }
  if (context.active.has(source)) {
    throw schemaError(context.label, path, "must not contain cycles.");
  }
  context.schemaNodes += 1;
  if (context.schemaNodes > MAX_SCHEMA_NODES) {
    throw schemaError(context.label, path, "contains too many schema nodes.");
  }
  context.active.add(source);
  try {
    const entries: any = ownDataEntries(source, context.label, path);
    for (const [keyword] of entries) {
      if (!SUPPORTED_KEYWORDS.has(keyword)) {
        throw schemaError(context.label, path, "contains an unsupported keyword.");
      }
    }

    const declaredTypes: any = readTypes(source, context.label, path);
    const effectiveTypes: any = assertKeywordTypeCompatibility(
      source,
      declaredTypes,
      context.label,
      path
    );
    const properties: any = new Map<any, any>();
    let canonicalProperties: any;
    if (Object.hasOwn(source, "properties")) {
      if (!isPlainObject(source.properties)) {
        throw schemaError(context.label, `${path}.properties`, "must be a plain object.");
      }
      const propertyEntries: any = ownDataEntries(source.properties, context.label, `${path}.properties`);
      if (propertyEntries.length > MAX_PROPERTIES_PER_SCHEMA) {
        throw schemaError(context.label, `${path}.properties`, "exceeds its cardinality limit.");
      }
      canonicalProperties = {};
      for (const [key, child] of propertyEntries) {
        assertPropertyName(key, context.label, `${path}.properties`);
        const compiledChild: any = compileSchemaNode(
          child,
          context,
          `${path}.properties.${key}`,
          depth + 1
        );
        properties.set(key, compiledChild);
        canonicalProperties[key] = compiledChild.schema;
      }
      Object.freeze(canonicalProperties);
    }

    let required: any[] = [];
    let canonicalRequired: any;
    if (Object.hasOwn(source, "required")) {
      if (!Array.isArray(source.required) || source.required.length > MAX_REQUIRED_FIELDS) {
        throw schemaError(context.label, `${path}.required`, "must be a bounded string array.");
      }
      const seen: any = new Set<any>();
      const declaredProperties: any = canonicalProperties
        ? new Set<any>(Object.keys(canonicalProperties))
        : inheritedProperties;
      required = source.required.map((key?: any) : any => {
        assertPropertyName(key, context.label, `${path}.required`);
        if (seen.has(key)) {
          throw schemaError(context.label, `${path}.required`, "must not contain duplicates.");
        }
        if (!declaredProperties?.has(key)) {
          throw schemaError(context.label, `${path}.required`, "references an undeclared property.");
        }
        seen.add(key);
        return key;
      });
      canonicalRequired = Object.freeze([...required]);
    }

    let additionalProperties: any = true;
    let canonicalAdditionalProperties: any;
    if (Object.hasOwn(source, "additionalProperties")) {
      if (typeof source.additionalProperties === "boolean") {
        additionalProperties = source.additionalProperties;
        canonicalAdditionalProperties = source.additionalProperties;
      } else {
        additionalProperties = compileSchemaNode(
          source.additionalProperties,
          context,
          `${path}.additionalProperties`,
          depth + 1
        );
        canonicalAdditionalProperties = additionalProperties.schema;
      }
    }

    let items: any;
    if (Object.hasOwn(source, "items")) {
      items = compileSchemaNode(source.items, context, `${path}.items`, depth + 1);
    }

    const minimum: any = readFiniteNumber(source, "minimum", context.label, path);
    const maximum: any = readFiniteNumber(source, "maximum", context.label, path);
    const minLength: any = readNonNegativeInteger(source, "minLength", context.label, path);
    const maxLength: any = readNonNegativeInteger(source, "maxLength", context.label, path);
    const minItems: any = readNonNegativeInteger(source, "minItems", context.label, path);
    const maxItems: any = readNonNegativeInteger(source, "maxItems", context.label, path);
    const minProperties: any = readNonNegativeInteger(source, "minProperties", context.label, path);
    const maxProperties: any = readNonNegativeInteger(source, "maxProperties", context.label, path);
    assertOrderedBounds(minimum, maximum, context.label, path, ["minimum", "maximum"]);
    assertOrderedBounds(minLength, maxLength, context.label, path, ["minLength", "maxLength"]);
    assertOrderedBounds(minItems, maxItems, context.label, path, ["minItems", "maxItems"]);
    assertOrderedBounds(
      minProperties,
      maxProperties,
      context.label,
      path,
      ["minProperties", "maxProperties"]
    );

    let enumValues: any;
    if (Object.hasOwn(source, "enum")) {
      if (
        !Array.isArray(source.enum) ||
        source.enum.length === 0 ||
        source.enum.length > MAX_ENUM_VALUES
      ) {
        throw schemaError(context.label, `${path}.enum`, "must be a bounded non-empty array.");
      }
      enumValues = source.enum.map((value?: any, index?: any) : any =>
        cloneJsonLiteral(value, context, context.label, `${path}.enum[${index}]`)
      );
      const enumKeys: any = new Set<any>(enumValues.map(jsonLiteralKey));
      if (enumKeys.size !== enumValues.length) {
        throw schemaError(context.label, `${path}.enum`, "must contain unique values.");
      }
      Object.freeze(enumValues);
    }

    let constValue: any;
    const hasConst: any = Object.hasOwn(source, "const");
    if (hasConst) {
      constValue = cloneJsonLiteral(source.const, context, context.label, `${path}.const`);
    }

    let format: any = "";
    if (Object.hasOwn(source, "format")) {
      if (typeof source.format !== "string" || !SUPPORTED_FORMATS.has(source.format)) {
        throw schemaError(context.label, `${path}.format`, "is unsupported.");
      }
      format = source.format;
    }
    const pattern: any = Object.hasOwn(source, "pattern")
      ? compileSafePattern(source.pattern, context.label, `${path}.pattern`)
      : null;

    const branchProperties: any = canonicalProperties
      ? new Set<any>(Object.keys(canonicalProperties))
      : inheritedProperties;
    const allOf: any = compileBranches(source, "allOf", context, path, depth, branchProperties);
    const anyOf: any = compileBranches(source, "anyOf", context, path, depth, branchProperties);
    const oneOf: any = compileBranches(source, "oneOf", context, path, depth, branchProperties);
    const not: any = Object.hasOwn(source, "not")
      ? compileSchemaNode(source.not, context, `${path}.not`, depth + 1, branchProperties)
      : null;

    const canonicalByKeyword: Record<string, any> = {
      additionalProperties: canonicalAdditionalProperties,
      allOf: allOf.length ? Object.freeze(allOf.map((branch?: any) : any => branch.schema)) : undefined,
      anyOf: anyOf.length ? Object.freeze(anyOf.map((branch?: any) : any => branch.schema)) : undefined,
      const: constValue,
      enum: enumValues,
      format: format || undefined,
      items: items?.schema,
      maximum,
      maxItems,
      maxLength,
      maxProperties,
      minimum,
      minItems,
      minLength,
      minProperties,
      not: not?.schema,
      oneOf: oneOf.length ? Object.freeze(oneOf.map((branch?: any) : any => branch.schema)) : undefined,
      pattern: pattern ? source.pattern : undefined,
      properties: canonicalProperties,
      required: canonicalRequired,
      type: Array.isArray(source.type)
        ? Object.freeze([...declaredTypes])
        : source.type
    };
    const canonicalSchema: Record<string, any> = {};
    for (const [keyword] of entries) {
      canonicalSchema[keyword] = canonicalByKeyword[keyword];
    }
    Object.freeze(canonicalSchema);

    return Object.freeze({
      additionalProperties,
      allOf,
      anyOf,
      constValue,
      effectiveTypes,
      enumValues,
      format,
      hasConst,
      items,
      maximum,
      maxItems,
      maxLength,
      maxProperties,
      minimum,
      minItems,
      minLength,
      minProperties,
      not,
      oneOf,
      pattern,
      properties,
      required,
      schema: canonicalSchema
    });
  } finally {
    context.active.delete(source);
  }
}

function valueMatchesType(value?: any, type?: any) : any {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isPlainObject(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function jsonValuesEqual(left?: any, right?: any, context?: any) : any {
  context.steps += 1;
  if (context.steps > MAX_VALIDATION_STEPS) return false;
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry?: any, index?: any) : any => jsonValuesEqual(entry, right[index], context));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys: any = Object.keys(left);
  const rightKeys: any = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key?: any) : any =>
    Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key], context)
  );
}

function stringLength(value?: any) : any {
  let length: any = 0;
  for (const _character of value) length += 1;
  return length;
}

function isValidDate(value?: any) : any {
  const match: any = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date: any = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function isValidHostname(value?: any) : any {
  return value.length > 0 &&
    value.length <= 253 &&
    !value.endsWith(".") &&
    value.split(".").every((part?: any) : any =>
      part.length > 0 &&
      part.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(part)
    );
}

function matchesFormat(value?: any, format?: any) : any {
  switch (format) {
    case "date":
      return isValidDate(value);
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value));
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "hostname":
      return isValidHostname(value);
    case "ipv4":
      return isIP(value) === 4;
    case "ipv6":
      return isIP(value) === 6;
    case "time":
      return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][01]\d:[0-5]\d)?$/u.test(value);
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "url":
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    default:
      return false;
  }
}

function validationFailure(error?: any) : any {
  return { ok: false, error };
}

function validateNode(node?: any, value?: any, path?: any, context?: any) : any {
  context.steps += 1;
  if (context.steps > MAX_VALIDATION_STEPS) {
    return validationFailure(`${path} exceeds the validation work limit.`);
  }
  if (
    node.effectiveTypes.length > 0 &&
    !node.effectiveTypes.some((type?: any) : any => valueMatchesType(value, type))
  ) {
    return validationFailure(`${path} must be ${node.effectiveTypes.join(" or ")}.`);
  }
  if (node.enumValues && !node.enumValues.some((entry?: any) : any =>
    jsonValuesEqual(entry, value, context)
  )) {
    return validationFailure(`${path} must match a declared enum value.`);
  }
  if (node.hasConst && !jsonValuesEqual(node.constValue, value, context)) {
    return validationFailure(`${path} must match the declared const value.`);
  }
  for (const branch of node.allOf) {
    const result: any = validateNode(branch, value, path, context);
    if (!result.ok) return validationFailure(`${path} does not satisfy allOf.`);
  }
  if (node.anyOf.length > 0) {
    let matched: any = false;
    for (const branch of node.anyOf) {
      const branchContext: Record<string, any> = { steps: context.steps };
      if (validateNode(branch, value, path, branchContext).ok) matched = true;
      context.steps = Math.max(context.steps, branchContext.steps);
      if (matched) break;
    }
    if (!matched) return validationFailure(`${path} does not satisfy anyOf.`);
  }
  if (node.oneOf.length > 0) {
    let matches: any = 0;
    for (const branch of node.oneOf) {
      const branchContext: Record<string, any> = { steps: context.steps };
      if (validateNode(branch, value, path, branchContext).ok) matches += 1;
      context.steps = Math.max(context.steps, branchContext.steps);
    }
    if (matches !== 1) return validationFailure(`${path} does not satisfy exactly one oneOf branch.`);
  }
  if (node.not) {
    const branchContext: Record<string, any> = { steps: context.steps };
    const matched: any = validateNode(node.not, value, path, branchContext).ok;
    context.steps = Math.max(context.steps, branchContext.steps);
    if (matched) return validationFailure(`${path} matches the disallowed schema.`);
  }

  if (typeof value === "string") {
    const length: any = stringLength(value);
    if (node.minLength !== undefined && length < node.minLength) {
      return validationFailure(`${path} is shorter than minLength.`);
    }
    if (node.maxLength !== undefined && length > node.maxLength) {
      return validationFailure(`${path} exceeds maxLength.`);
    }
    if (node.pattern && !node.pattern.test(value)) {
      return validationFailure(`${path} must match the declared pattern.`);
    }
    if (node.format && !matchesFormat(value, node.format)) {
      return validationFailure(`${path} must match format ${node.format}.`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (node.minimum !== undefined && value < node.minimum) {
      return validationFailure(`${path} is below minimum.`);
    }
    if (node.maximum !== undefined && value > node.maximum) {
      return validationFailure(`${path} exceeds maximum.`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_VALUE_COLLECTION_SIZE) {
      return validationFailure(`${path} exceeds the collection validation limit.`);
    }
    if (node.minItems !== undefined && value.length < node.minItems) {
      return validationFailure(`${path} has fewer items than minItems.`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      return validationFailure(`${path} has more items than maxItems.`);
    }
    if (node.items) {
      for (let index: any = 0; index < value.length; index += 1) {
        const result: any = validateNode(node.items, value[index], `${path}[${index}]`, context);
        if (!result.ok) return result;
      }
    }
  }
  if (isPlainObject(value)) {
    const keys: any = Object.keys(value);
    if (keys.length > MAX_VALUE_COLLECTION_SIZE) {
      return validationFailure(`${path} exceeds the collection validation limit.`);
    }
    if (node.minProperties !== undefined && keys.length < node.minProperties) {
      return validationFailure(`${path} has fewer properties than minProperties.`);
    }
    if (node.maxProperties !== undefined && keys.length > node.maxProperties) {
      return validationFailure(`${path} has more properties than maxProperties.`);
    }
    for (const key of node.required) {
      if (!Object.hasOwn(value, key)) {
        return validationFailure(`${path} is missing a required property.`);
      }
    }
    for (const key of keys) {
      const propertySchema: any = node.properties.get(key);
      if (propertySchema) {
        const result: any = validateNode(propertySchema, value[key], `${path}.${key}`, context);
        if (!result.ok) return result;
        continue;
      }
      if (node.additionalProperties === false) {
        return validationFailure(`${path} contains an undeclared property.`);
      }
      if (node.additionalProperties !== true) {
        const result: any = validateNode(node.additionalProperties, value[key], `${path}.${key}`, context);
        if (!result.ok) return result;
      }
    }
  }
  return { ok: true };
}

export function compileClosedJsonSchema(
  schema?: any,
  { label = "JSON schema", requireTopLevelObject = false }: Record<string, any> = {}
) : any {
  const safeLabel: any = typeof label === "string" && label.trim()
    ? label.trim().slice(0, 160)
    : "JSON schema";
  const context: Record<string, any> = {
    active: new WeakSet<object>(),
    label: safeLabel,
    literalNodes: 0,
    schemaNodes: 0
  };
  const root: any = compileSchemaNode(schema, context, "$", 0);
  if (
    requireTopLevelObject &&
    (root.effectiveTypes.length !== 1 || root.effectiveTypes[0] !== "object")
  ) {
    throw schemaError(safeLabel, "$", "must declare an object root.");
  }
  const validate: any = (value?: any) : any => {
    try {
      return validateNode(root, value, "$", { steps: 0 });
    } catch {
      return validationFailure("$ could not be validated safely.");
    }
  };
  Object.freeze(validate);
  return Object.freeze({
    schema: root.schema,
    validate
  });
}

export const CLOSED_EMPTY_JSON_OBJECT_SCHEMA: any = compileClosedJsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false
}, {
  label: "Closed empty JSON object schema",
  requireTopLevelObject: true
}).schema;
