import { isIP } from "node:net";

export type ClosedJsonValue = null | boolean | number | string |
  readonly ClosedJsonValue[] | Readonly<{ [key: string]: ClosedJsonValue }>;
export type ClosedJsonSchema = Readonly<{ [keyword: string]: ClosedJsonValue }>;
export type ClosedJsonSchemaValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: string }>;

export interface CompiledClosedJsonSchema {
  readonly schema: ClosedJsonSchema;
  readonly validate: (value?: unknown) => ClosedJsonSchemaValidationResult;
}
export interface CompileClosedJsonSchemaOptions {
  readonly label?: string;
  readonly requireTopLevelObject?: boolean;
}

type SchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";
type SchemaFormat = "date" | "date-time" | "email" | "hostname" | "ipv4" | "ipv6" |
  "time" | "uri" | "url" | "uuid";
type CombinatorKeyword = "allOf" | "anyOf" | "oneOf";
type SupportedKeyword = "additionalProperties" | CombinatorKeyword | "const" | "enum" |
  "format" | "items" | "maximum" | "maxItems" | "maxLength" | "maxProperties" |
  "minimum" | "minItems" | "minLength" | "minProperties" | "not" | "pattern" |
  "properties" | "required" | "type";
type NonNegativeIntegerKeyword = "maxItems" | "maxLength" | "maxProperties" |
  "minItems" | "minLength" | "minProperties";
type FiniteNumberKeyword = "maximum" | "minimum";

interface CompilationContext {
  readonly active: WeakSet<object>;
  readonly label: string;
  literalNodes: number;
  schemaNodes: number;
}
interface ValidationContext { steps: number }
interface CompiledSchemaNode {
  readonly additionalProperties: boolean | CompiledSchemaNode;
  readonly allOf: readonly CompiledSchemaNode[];
  readonly anyOf: readonly CompiledSchemaNode[];
  readonly constValue: ClosedJsonValue | undefined;
  readonly effectiveTypes: readonly SchemaType[];
  readonly enumValues: readonly ClosedJsonValue[] | undefined;
  readonly format: SchemaFormat | "";
  readonly hasConst: boolean;
  readonly items: CompiledSchemaNode | undefined;
  readonly maximum: number | undefined;
  readonly maxItems: number | undefined;
  readonly maxLength: number | undefined;
  readonly maxProperties: number | undefined;
  readonly minimum: number | undefined;
  readonly minItems: number | undefined;
  readonly minLength: number | undefined;
  readonly minProperties: number | undefined;
  readonly not: CompiledSchemaNode | null;
  readonly oneOf: readonly CompiledSchemaNode[];
  readonly pattern: RegExp | null;
  readonly properties: ReadonlyMap<string, CompiledSchemaNode>;
  readonly required: readonly string[];
  readonly schema: ClosedJsonSchema;
}

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "array", "boolean", "integer", "null", "number", "object", "string"
]);
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date", "date-time", "email", "hostname", "ipv4", "ipv6", "time", "uri", "url", "uuid"
]);
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties", "allOf", "anyOf", "const", "enum", "format", "items",
  "maximum", "maxItems", "maxLength", "maxProperties", "minimum", "minItems",
  "minLength", "minProperties", "not", "oneOf", "pattern", "properties", "required", "type"
]);
const OBJECT_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties", "maxProperties", "minProperties", "properties", "required"
]);
const ARRAY_KEYWORDS: ReadonlySet<string> = new Set(["items", "maxItems", "minItems"]);
const STRING_KEYWORDS: ReadonlySet<string> = new Set(["format", "maxLength", "minLength", "pattern"]);
const NUMBER_KEYWORDS: ReadonlySet<string> = new Set(["maximum", "minimum"]);
const UNSAFE_PROPERTY_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 512;
const MAX_PROPERTIES_PER_SCHEMA = 128;
const MAX_REQUIRED_FIELDS = 128;
const MAX_ENUM_VALUES = 128;
const MAX_COMBINATOR_BRANCHES = 32;
const MAX_LITERAL_DEPTH = 16;
const MAX_LITERAL_NODES = 4096;
const MAX_VALUE_COLLECTION_SIZE = 4096;
const MAX_VALIDATION_STEPS = 32768;
const MAX_PATTERN_LENGTH = 160;
const MAX_PROPERTY_NAME_LENGTH = 256;

class ClosedJsonSchemaError extends TypeError {
  readonly code = "closed_json_schema_invalid";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isSchemaType(value: unknown): value is SchemaType {
  return typeof value === "string" && SUPPORTED_TYPES.has(value);
}
function isSchemaFormat(value: unknown): value is SchemaFormat {
  return typeof value === "string" && SUPPORTED_FORMATS.has(value);
}
function isSupportedKeyword(value: string): value is SupportedKeyword {
  return SUPPORTED_KEYWORDS.has(value);
}
function isJsonArray(value: ClosedJsonValue): value is readonly ClosedJsonValue[] {
  return Array.isArray(value);
}
function schemaError(label: string, path: string, reason: string): ClosedJsonSchemaError {
  return new ClosedJsonSchemaError(`${label} ${path} ${reason}`);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function ownDataEntries(
  value: Record<string, unknown>, label: string, path: string
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw schemaError(label, path, "contains an unsupported symbol key.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw schemaError(label, path, "must contain only enumerable data properties.");
    }
    const entry: unknown = descriptor.value;
    entries.push([key, entry]);
  }
  return entries;
}

function assertPropertyName(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > MAX_PROPERTY_NAME_LENGTH || UNSAFE_PROPERTY_NAMES.has(value) ||
    containsControlCharacter(value)) {
    throw schemaError(label, path, "contains an invalid property name.");
  }
  return value;
}

function cloneJsonLiteral(
  value: unknown, state: CompilationContext, label: string, path: string, depth = 0,
  active: WeakSet<object> = new WeakSet<object>()
): ClosedJsonValue {
  if (depth > MAX_LITERAL_DEPTH) {
    throw schemaError(label, path, "contains an excessively nested JSON value.");
  }
  state.literalNodes += 1;
  if (state.literalNodes > MAX_LITERAL_NODES) {
    throw schemaError(label, path, "contains too many JSON value nodes.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw schemaError(label, path, "must contain finite JSON numbers.");
    return value;
  }
  if (!value || typeof value !== "object") {
    throw schemaError(label, path, "must contain only JSON-compatible values.");
  }
  if (active.has(value)) throw schemaError(label, path, "must not contain cycles.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_LITERAL_NODES) {
        throw schemaError(label, path, "contains an oversized JSON array.");
      }
      return Object.freeze(value.map((entry, index) =>
        cloneJsonLiteral(entry, state, label, `${path}[${index}]`, depth + 1, active)));
    }
    if (!isPlainObject(value)) throw schemaError(label, path, "must contain only JSON objects.");
    const entries = ownDataEntries(value, label, path);
    if (entries.length > MAX_LITERAL_NODES) {
      throw schemaError(label, path, "contains an oversized JSON object.");
    }
    const output: Record<string, ClosedJsonValue> = {};
    for (const [key, entry] of entries) {
      assertPropertyName(key, label, path);
      output[key] = cloneJsonLiteral(entry, state, label, `${path}.${key}`, depth + 1, active);
    }
    return Object.freeze(output);
  } finally {
    active.delete(value);
  }
}

function jsonLiteralKey(value: ClosedJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") return `number:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (isJsonArray(value)) return `array:[${value.map(jsonLiteralKey).join(",")}]`;
  return `object:{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${jsonLiteralKey(value[key])}`).join(",")}}`;
}

function readTypes(source: Record<string, unknown>, label: string, path: string): SchemaType[] {
  if (!Object.hasOwn(source, "type")) return [];
  const rawTypes: unknown[] = Array.isArray(source.type) ? source.type : [source.type];
  if (rawTypes.length === 0 || rawTypes.length > SUPPORTED_TYPES.size) {
    throw schemaError(label, `${path}.type`, "must declare at least one supported type.");
  }
  const types: SchemaType[] = [];
  for (const rawType of rawTypes) {
    if (!isSchemaType(rawType) || types.includes(rawType)) {
      throw schemaError(label, `${path}.type`, "contains an unsupported or duplicate type.");
    }
    types.push(rawType);
  }
  return types;
}

function inferredTypes(source: Record<string, unknown>): Set<SchemaType> {
  const inferred = new Set<SchemaType>();
  for (const keyword of Object.keys(source)) {
    if (OBJECT_KEYWORDS.has(keyword)) inferred.add("object");
    if (ARRAY_KEYWORDS.has(keyword)) inferred.add("array");
    if (STRING_KEYWORDS.has(keyword)) inferred.add("string");
    if (NUMBER_KEYWORDS.has(keyword)) inferred.add("number");
  }
  return inferred;
}

function assertKeywordTypeCompatibility(
  source: Record<string, unknown>, types: SchemaType[], label: string, path: string
): SchemaType[] {
  const inferred = inferredTypes(source);
  if (types.length === 0 && inferred.size > 1) {
    throw schemaError(label, path, "mixes constraints for incompatible value types.");
  }
  if (types.length === 0) return [...inferred];
  const supports = (type: SchemaType): boolean => types.includes(type) ||
    (type === "number" && types.includes("integer"));
  for (const type of inferred) {
    if (!supports(type)) {
      throw schemaError(label, path, `uses ${type} constraints without declaring that type.`);
    }
  }
  return types;
}

function readNonNegativeInteger(
  source: Record<string, unknown>, keyword: NonNegativeIntegerKeyword, label: string, path: string
): number | undefined {
  if (!Object.hasOwn(source, keyword)) return undefined;
  const value = source[keyword];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw schemaError(label, `${path}.${keyword}`, "must be a non-negative safe integer.");
  }
  return value;
}
function readFiniteNumber(
  source: Record<string, unknown>, keyword: FiniteNumberKeyword, label: string, path: string
): number | undefined {
  if (!Object.hasOwn(source, keyword)) return undefined;
  const value = source[keyword];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw schemaError(label, `${path}.${keyword}`, "must be a finite number.");
  }
  return value;
}
function assertOrderedBounds(
  minimum: number | undefined, maximum: number | undefined, label: string, path: string,
  names: readonly [string, string]
): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw schemaError(label, path, `${names[0]} must not exceed ${names[1]}.`);
  }
}

function compileSafePattern(value: unknown, label: string, path: string): readonly [string, RegExp] {
  if (typeof value !== "string" || value.length > MAX_PATTERN_LENGTH) {
    throw schemaError(label, path, `must be a string of at most ${MAX_PATTERN_LENGTH} characters.`);
  }
  if (/\\[1-9]/u.test(value) || /\(\?/u.test(value) ||
    /\([^)]*[*+][^)]*\)\s*(?:[*+?]|\{\d*,?\d*\})/u.test(value) ||
    (value.match(/\.\*/gu) || []).length > 1) {
    throw schemaError(label, path, "uses unsupported regular-expression syntax.");
  }
  try {
    return [value, new RegExp(value, "u")];
  } catch {
    throw schemaError(label, path, "must be a valid bounded regular expression.");
  }
}

function compileBranches(
  source: Record<string, unknown>, keyword: CombinatorKeyword, context: CompilationContext,
  path: string, depth: number, inheritedProperties: ReadonlySet<string> | null
): CompiledSchemaNode[] {
  if (!Object.hasOwn(source, keyword)) return [];
  const branches = source[keyword];
  if (!Array.isArray(branches) || branches.length === 0 || branches.length > MAX_COMBINATOR_BRANCHES) {
    throw schemaError(context.label, `${path}.${keyword}`,
      `must contain between 1 and ${MAX_COMBINATOR_BRANCHES} schemas.`);
  }
  return branches.map((branch, index) => compileSchemaNode(
    branch, context, `${path}.${keyword}[${index}]`, depth + 1, inheritedProperties
  ));
}

function compileSchemaNode(
  source: unknown, context: CompilationContext, path: string, depth: number,
  inheritedProperties: ReadonlySet<string> | null = null
): CompiledSchemaNode {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw schemaError(context.label, path, "exceeds the supported nesting depth.");
  }
  if (!isPlainObject(source)) throw schemaError(context.label, path, "must be a plain object.");
  if (context.active.has(source)) throw schemaError(context.label, path, "must not contain cycles.");
  context.schemaNodes += 1;
  if (context.schemaNodes > MAX_SCHEMA_NODES) {
    throw schemaError(context.label, path, "contains too many schema nodes.");
  }
  context.active.add(source);
  try {
    const entries = ownDataEntries(source, context.label, path);
    const keywords: SupportedKeyword[] = [];
    for (const [keyword] of entries) {
      if (!isSupportedKeyword(keyword)) {
        throw schemaError(context.label, path, "contains an unsupported keyword.");
      }
      keywords.push(keyword);
    }
    const declaredTypes = readTypes(source, context.label, path);
    const effectiveTypes = assertKeywordTypeCompatibility(source, declaredTypes, context.label, path);
    const properties = new Map<string, CompiledSchemaNode>();
    let canonicalProperties: Record<string, ClosedJsonSchema> | undefined;
    if (Object.hasOwn(source, "properties")) {
      if (!isPlainObject(source.properties)) {
        throw schemaError(context.label, `${path}.properties`, "must be a plain object.");
      }
      const propertyEntries = ownDataEntries(source.properties, context.label, `${path}.properties`);
      if (propertyEntries.length > MAX_PROPERTIES_PER_SCHEMA) {
        throw schemaError(context.label, `${path}.properties`, "exceeds its cardinality limit.");
      }
      canonicalProperties = {};
      for (const [key, child] of propertyEntries) {
        assertPropertyName(key, context.label, `${path}.properties`);
        const compiledChild = compileSchemaNode(child, context, `${path}.properties.${key}`, depth + 1);
        properties.set(key, compiledChild);
        canonicalProperties[key] = compiledChild.schema;
      }
      Object.freeze(canonicalProperties);
    }

    let required: string[] = [];
    let canonicalRequired: readonly string[] | undefined;
    if (Object.hasOwn(source, "required")) {
      if (!Array.isArray(source.required) || source.required.length > MAX_REQUIRED_FIELDS) {
        throw schemaError(context.label, `${path}.required`, "must be a bounded string array.");
      }
      const seen = new Set<string>();
      const declaredProperties: ReadonlySet<string> | null = canonicalProperties
        ? new Set(Object.keys(canonicalProperties)) : inheritedProperties;
      required = source.required.map((rawKey) => {
        const key = assertPropertyName(rawKey, context.label, `${path}.required`);
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

    let additionalProperties: boolean | CompiledSchemaNode = true;
    let canonicalAdditionalProperties: boolean | ClosedJsonSchema | undefined;
    if (Object.hasOwn(source, "additionalProperties")) {
      if (typeof source.additionalProperties === "boolean") {
        additionalProperties = source.additionalProperties;
        canonicalAdditionalProperties = source.additionalProperties;
      } else {
        additionalProperties = compileSchemaNode(
          source.additionalProperties, context, `${path}.additionalProperties`, depth + 1
        );
        canonicalAdditionalProperties = additionalProperties.schema;
      }
    }
    const items = Object.hasOwn(source, "items")
      ? compileSchemaNode(source.items, context, `${path}.items`, depth + 1) : undefined;
    const minimum = readFiniteNumber(source, "minimum", context.label, path);
    const maximum = readFiniteNumber(source, "maximum", context.label, path);
    const minLength = readNonNegativeInteger(source, "minLength", context.label, path);
    const maxLength = readNonNegativeInteger(source, "maxLength", context.label, path);
    const minItems = readNonNegativeInteger(source, "minItems", context.label, path);
    const maxItems = readNonNegativeInteger(source, "maxItems", context.label, path);
    const minProperties = readNonNegativeInteger(source, "minProperties", context.label, path);
    const maxProperties = readNonNegativeInteger(source, "maxProperties", context.label, path);
    assertOrderedBounds(minimum, maximum, context.label, path, ["minimum", "maximum"]);
    assertOrderedBounds(minLength, maxLength, context.label, path, ["minLength", "maxLength"]);
    assertOrderedBounds(minItems, maxItems, context.label, path, ["minItems", "maxItems"]);
    assertOrderedBounds(minProperties, maxProperties, context.label, path,
      ["minProperties", "maxProperties"]);

    let enumValues: ClosedJsonValue[] | undefined;
    if (Object.hasOwn(source, "enum")) {
      if (!Array.isArray(source.enum) || source.enum.length === 0 || source.enum.length > MAX_ENUM_VALUES) {
        throw schemaError(context.label, `${path}.enum`, "must be a bounded non-empty array.");
      }
      enumValues = source.enum.map((value, index) =>
        cloneJsonLiteral(value, context, context.label, `${path}.enum[${index}]`));
      const enumKeys = new Set(enumValues.map(jsonLiteralKey));
      if (enumKeys.size !== enumValues.length) {
        throw schemaError(context.label, `${path}.enum`, "must contain unique values.");
      }
      Object.freeze(enumValues);
    }
    const hasConst = Object.hasOwn(source, "const");
    const constValue = hasConst
      ? cloneJsonLiteral(source.const, context, context.label, `${path}.const`) : undefined;
    let format: SchemaFormat | "" = "";
    if (Object.hasOwn(source, "format")) {
      if (!isSchemaFormat(source.format)) {
        throw schemaError(context.label, `${path}.format`, "is unsupported.");
      }
      format = source.format;
    }
    let pattern: RegExp | null = null;
    let canonicalPattern: string | undefined;
    if (Object.hasOwn(source, "pattern")) {
      [canonicalPattern, pattern] = compileSafePattern(source.pattern, context.label, `${path}.pattern`);
    }
    const branchProperties: ReadonlySet<string> | null = canonicalProperties
      ? new Set(Object.keys(canonicalProperties)) : inheritedProperties;
    const allOf = compileBranches(source, "allOf", context, path, depth, branchProperties);
    const anyOf = compileBranches(source, "anyOf", context, path, depth, branchProperties);
    const oneOf = compileBranches(source, "oneOf", context, path, depth, branchProperties);
    const not = Object.hasOwn(source, "not")
      ? compileSchemaNode(source.not, context, `${path}.not`, depth + 1, branchProperties) : null;

    const canonicalByKeyword: Record<SupportedKeyword, ClosedJsonValue | undefined> = {
      additionalProperties: canonicalAdditionalProperties,
      allOf: allOf.length ? Object.freeze(allOf.map((branch) => branch.schema)) : undefined,
      anyOf: anyOf.length ? Object.freeze(anyOf.map((branch) => branch.schema)) : undefined,
      const: constValue,
      enum: enumValues,
      format: format || undefined,
      items: items?.schema,
      maximum, maxItems, maxLength, maxProperties, minimum, minItems, minLength, minProperties,
      not: not?.schema,
      oneOf: oneOf.length ? Object.freeze(oneOf.map((branch) => branch.schema)) : undefined,
      pattern: canonicalPattern,
      properties: canonicalProperties,
      required: canonicalRequired,
      type: Object.hasOwn(source, "type")
        ? Array.isArray(source.type) ? Object.freeze([...declaredTypes]) : declaredTypes[0]
        : undefined
    };
    const canonicalSchema: Record<string, ClosedJsonValue> = {};
    for (const keyword of keywords) {
      const value = canonicalByKeyword[keyword];
      if (value === undefined) {
        throw schemaError(context.label, path, `could not canonicalize ${keyword}.`);
      }
      canonicalSchema[keyword] = value;
    }
    Object.freeze(canonicalSchema);
    return Object.freeze({
      additionalProperties, allOf, anyOf, constValue, effectiveTypes, enumValues, format,
      hasConst, items, maximum, maxItems, maxLength, maxProperties, minimum, minItems,
      minLength, minProperties, not, oneOf, pattern, properties, required, schema: canonicalSchema
    });
  } finally {
    context.active.delete(source);
  }
}

function valueMatchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return isPlainObject(value);
    case "string": return typeof value === "string";
  }
}

function jsonValuesEqual(left: unknown, right: unknown, context: ValidationContext): boolean {
  context.steps += 1;
  if (context.steps > MAX_VALIDATION_STEPS) return false;
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonValuesEqual(entry, right[index], context));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key], context));
}
function stringLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}
function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}
function isValidHostname(value: string): boolean {
  return value.length > 0 && value.length <= 253 && !value.endsWith(".") &&
    value.split(".").every((part) => part.length > 0 && part.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(part));
}
function matchesFormat(value: string, format: SchemaFormat): boolean {
  switch (format) {
    case "date": return isValidDate(value);
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value));
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "hostname": return isValidHostname(value);
    case "ipv4": return isIP(value) === 4;
    case "ipv6": return isIP(value) === 6;
    case "time":
      return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][01]\d:[0-5]\d)?$/u.test(value);
    case "uri":
      try { new URL(value); return true; } catch { return false; }
    case "url":
      try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  }
}

function validationFailure(error: string): ClosedJsonSchemaValidationResult {
  return { ok: false, error };
}
function validateNode(
  node: CompiledSchemaNode, value: unknown, path: string, context: ValidationContext
): ClosedJsonSchemaValidationResult {
  context.steps += 1;
  if (context.steps > MAX_VALIDATION_STEPS) {
    return validationFailure(`${path} exceeds the validation work limit.`);
  }
  if (node.effectiveTypes.length > 0 &&
    !node.effectiveTypes.some((type) => valueMatchesType(value, type))) {
    return validationFailure(`${path} must be ${node.effectiveTypes.join(" or ")}.`);
  }
  if (node.enumValues && !node.enumValues.some((entry) => jsonValuesEqual(entry, value, context))) {
    return validationFailure(`${path} must match a declared enum value.`);
  }
  if (node.hasConst && !jsonValuesEqual(node.constValue, value, context)) {
    return validationFailure(`${path} must match the declared const value.`);
  }
  for (const branch of node.allOf) {
    if (!validateNode(branch, value, path, context).ok) {
      return validationFailure(`${path} does not satisfy allOf.`);
    }
  }
  if (node.anyOf.length > 0) {
    let matched = false;
    for (const branch of node.anyOf) {
      const branchContext: ValidationContext = { steps: context.steps };
      if (validateNode(branch, value, path, branchContext).ok) matched = true;
      context.steps = Math.max(context.steps, branchContext.steps);
      if (matched) break;
    }
    if (!matched) return validationFailure(`${path} does not satisfy anyOf.`);
  }
  if (node.oneOf.length > 0) {
    let matches = 0;
    for (const branch of node.oneOf) {
      const branchContext: ValidationContext = { steps: context.steps };
      if (validateNode(branch, value, path, branchContext).ok) matches += 1;
      context.steps = Math.max(context.steps, branchContext.steps);
    }
    if (matches !== 1) return validationFailure(`${path} does not satisfy exactly one oneOf branch.`);
  }
  if (node.not) {
    const branchContext: ValidationContext = { steps: context.steps };
    const matched = validateNode(node.not, value, path, branchContext).ok;
    context.steps = Math.max(context.steps, branchContext.steps);
    if (matched) return validationFailure(`${path} matches the disallowed schema.`);
  }
  if (typeof value === "string") {
    const length = stringLength(value);
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
      for (let index = 0; index < value.length; index += 1) {
        const result = validateNode(node.items, value[index], `${path}[${index}]`, context);
        if (!result.ok) return result;
      }
    }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
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
      const propertySchema = node.properties.get(key);
      if (propertySchema) {
        const result = validateNode(propertySchema, value[key], `${path}.${key}`, context);
        if (!result.ok) return result;
      } else if (node.additionalProperties === false) {
        return validationFailure(`${path} contains an undeclared property.`);
      } else if (node.additionalProperties !== true) {
        const result = validateNode(node.additionalProperties, value[key], `${path}.${key}`, context);
        if (!result.ok) return result;
      }
    }
  }
  return { ok: true };
}

export function compileClosedJsonSchema(
  schema?: unknown,
  { label = "JSON schema", requireTopLevelObject = false }: CompileClosedJsonSchemaOptions = {}
): CompiledClosedJsonSchema {
  const safeLabel = typeof label === "string" && label.trim()
    ? label.trim().slice(0, 160) : "JSON schema";
  const context: CompilationContext = {
    active: new WeakSet<object>(), label: safeLabel, literalNodes: 0, schemaNodes: 0
  };
  const root = compileSchemaNode(schema, context, "$", 0);
  if (requireTopLevelObject &&
    (root.effectiveTypes.length !== 1 || root.effectiveTypes[0] !== "object")) {
    throw schemaError(safeLabel, "$", "must declare an object root.");
  }
  const validate = (value?: unknown): ClosedJsonSchemaValidationResult => {
    try {
      return validateNode(root, value, "$", { steps: 0 });
    } catch {
      return validationFailure("$ could not be validated safely.");
    }
  };
  Object.freeze(validate);
  return Object.freeze({ schema: root.schema, validate });
}

export const CLOSED_EMPTY_JSON_OBJECT_SCHEMA: ClosedJsonSchema = compileClosedJsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false
}, {
  label: "Closed empty JSON object schema",
  requireTopLevelObject: true
}).schema;
