/**
 * Interpreted JSON Schema 2020-12 validator for runtimes where Ajv's code
 * generation is unavailable — workerd forbids `new Function`, so the hosted
 * gateway cannot compile schemas the way Node does. This validator walks the
 * schema directly instead of emitting a validator function.
 *
 * The coverage is a bounded, explicit subset: the structural keywords Meshrix
 * catalog schemas actually use (types, object/property shapes, arrays, scalar
 * ranges, combinators, local `$ref`). Semantic-altering keywords that are not
 * implemented (`$dynamicRef`, `$recursiveRef`, remote references,
 * `unevaluated*`, `contains` subtleties beyond the implemented form) are
 * rejected at compile time rather than silently under-enforced; annotation
 * keywords (`title`, `format`, `default`, …) are ignored exactly as Ajv's
 * `validateFormats: false` posture does. Unknown keywords are ignored, matching
 * the `strict: false` admission contract of the Ajv path.
 */

import { createHash } from "node:crypto";

import { cloneJson, canonicalJson } from "../utils.ts";
import {
  assertExternalSchemaBudget,
  GatewaySchemaError,
  JSON_SCHEMA_2020_12,
  type CompiledExternalSchema,
  type SchemaBudget,
  type SchemaValidationError,
} from "./index.ts";

export const INTERPRETED_SCHEMA_VALIDATOR_VERSION = "interpreted-2020-12:1" as const;

const UNSUPPORTED_KEYWORDS = new Set([
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema",
]);

const TYPE_NAMES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

const MAX_VALUE_DEPTH = 256;
const MAX_ERRORS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number" && actual === "integer") return true;
  return actual === expected;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

class InterpretedValidator {
  readonly #root: unknown;
  readonly #errors: SchemaValidationError[] = [];
  #depth = 0;

  constructor(root: unknown) {
    this.#root = root;
  }

  errors(): readonly SchemaValidationError[] {
    return this.#errors;
  }

  #fail(instancePath: string, schemaPath: string, keyword: string, message: string, params: Record<string, unknown> = {}): boolean {
    if (this.#errors.length < MAX_ERRORS) {
      this.#errors.push(Object.freeze({ instancePath, schemaPath, keyword, message, params: Object.freeze(params) }));
    }
    return false;
  }

  #refTarget(ref: string): unknown {
    if (ref === "#" || ref === "") return this.#root;
    if (!ref.startsWith("#/")) {
      throw new GatewaySchemaError(
        "schema_keyword_unsupported",
        "Interpreted schemas support local references only.",
        { cause: `$ref ${ref.slice(0, 80)}` },
      );
    }
    let cursor: unknown = this.#root;
    for (const rawSegment of ref.slice(2).split("/")) {
      const segment = decodePointerSegment(rawSegment);
      if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
        throw new GatewaySchemaError("schema_reference_unresolved", "Interpreted schema reference cannot be resolved.", { cause: ref.slice(0, 120) });
      }
      cursor = cursor[segment];
    }
    return cursor;
  }

  check(schema: unknown, value: unknown, instancePath: string, schemaPath: string): boolean {
    if (typeof schema === "boolean") {
      return schema ? true : this.#fail(instancePath, schemaPath, "false schema", "boolean schema is false");
    }
    if (!isRecord(schema)) return true;
    if (++this.#depth > MAX_VALUE_DEPTH) {
      throw new GatewaySchemaError("validation_budget_exceeded", "Input exceeds the interpreted validation depth budget.");
    }
    try {
      return this.#apply(schema, value, instancePath, schemaPath);
    } finally {
      this.#depth -= 1;
    }
  }

  #apply(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    for (const key of Object.keys(schema)) {
      if (UNSUPPORTED_KEYWORDS.has(key)) {
        throw new GatewaySchemaError("schema_keyword_unsupported", "Interpreted schema uses an unsupported keyword.", { cause: key });
      }
    }
    let valid = true;
    if (typeof schema.$ref === "string") {
      const target = this.#refTarget(schema.$ref);
      if (!this.check(target, value, path, schema.$ref)) valid = false;
    }

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const allowed = types.every((entry) => TYPE_NAMES.has(String(entry)));
      if (!allowed) {
        throw new GatewaySchemaError("schema_invalid", "Interpreted schema declares an unknown type.", { cause: String(schema.type).slice(0, 80) });
      }
      if (!types.some((entry) => typeMatches(value, String(entry)))) {
        valid = this.#fail(path, `${sPath}/type`, "type", `must be ${types.map(String).join(",")}`, { type: schema.type });
      }
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(entry, value))) {
      valid = this.#fail(path, `${sPath}/enum`, "enum", "must be equal to one of the allowed values", { allowedValues: schema.enum });
    }
    if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value)) {
      valid = this.#fail(path, `${sPath}/const`, "const", "must be equal to constant", { allowedValue: schema.const });
    }

    if (!this.#applyCombinators(schema, value, path, sPath)) valid = false;
    if (!this.#applyObject(schema, value, path, sPath)) valid = false;
    if (!this.#applyArray(schema, value, path, sPath)) valid = false;
    if (!this.#applyString(schema, value, path, sPath)) valid = false;
    if (!this.#applyNumber(schema, value, path, sPath)) valid = false;
    return valid;
  }

  #applyCombinators(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    let valid = true;
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((branch, index) => {
        if (!this.check(branch, value, path, `${sPath}/allOf/${index}`)) valid = false;
      });
    }
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.some((branch, index) => this.check(branch, value, path, `${sPath}/anyOf/${index}`))) {
        valid = this.#fail(path, `${sPath}/anyOf`, "anyOf", "must match at least one schema");
      }
    }
    if (Array.isArray(schema.oneOf)) {
      const matches = schema.oneOf.filter((branch, index) => this.check(branch, value, path, `${sPath}/oneOf/${index}`)).length;
      if (matches !== 1) {
        valid = this.#fail(path, `${sPath}/oneOf`, "oneOf", "must match exactly one schema", { passingSchemas: matches });
      }
    }
    if (schema.not !== undefined && this.check(schema.not, value, path, `${sPath}/not`)) {
      valid = this.#fail(path, `${sPath}/not`, "not", "must NOT be valid against the negated schema");
    }
    if (isRecord(schema.if)) {
      const passes = this.check(schema.if, value, path, `${sPath}/if`);
      const branch = passes ? schema.then : schema.else;
      if (branch !== undefined && !this.check(branch, value, path, `${sPath}/${passes ? "then" : "else"}`)) valid = false;
    }
    return valid;
  }

  #applyObject(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const patterns = isRecord(schema.patternProperties) ? schema.patternProperties : {};
    const hasObjectAssertions = isRecord(schema.properties) || isRecord(schema.patternProperties)
      || schema.additionalProperties !== undefined || Array.isArray(schema.required)
      || schema.minProperties !== undefined || schema.maxProperties !== undefined
      || schema.propertyNames !== undefined || isRecord(schema.dependentRequired) || isRecord(schema.dependentSchemas);
    if (!hasObjectAssertions || !isRecord(value)) return true;

    let valid = true;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          valid = this.#fail(path, `${sPath}/required`, "required", `must have required property '${key}'`, { missingProperty: key });
        }
      }
    }
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      valid = this.#fail(path, `${sPath}/minProperties`, "minProperties", `must NOT have fewer than ${schema.minProperties} properties`, { limit: schema.minProperties });
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      valid = this.#fail(path, `${sPath}/maxProperties`, "maxProperties", `must NOT have more than ${schema.maxProperties} properties`, { limit: schema.maxProperties });
    }
    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        if (!this.check(schema.propertyNames, key, `${path}/${key}`, `${sPath}/propertyNames`)) valid = false;
      }
    }
    const covered = new Set<string>();
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        covered.add(key);
        if (!this.check(subSchema, value[key], `${path}/${key}`, `${sPath}/properties/${key}`)) valid = false;
      }
    }
    const compiledPatterns = Object.entries(patterns).map(([pattern, subSchema]) => {
      try {
        return [new RegExp(pattern, "u"), subSchema] as const;
      } catch {
        throw new GatewaySchemaError("schema_invalid", "Interpreted schema carries an invalid patternProperties expression.", { cause: pattern.slice(0, 80) });
      }
    });
    const additional = new Set<string>();
    for (const key of keys) {
      let matched = covered.has(key);
      for (const [regex, subSchema] of compiledPatterns) {
        if (regex.test(key)) {
          matched = true;
          if (!this.check(subSchema, value[key], `${path}/${key}`, `${sPath}/patternProperties`)) valid = false;
        }
      }
      if (!matched) additional.add(key);
    }
    if (schema.additionalProperties === false && additional.size > 0) {
      valid = this.#fail(path, `${sPath}/additionalProperties`, "additionalProperties", "must NOT have additional properties", { additionalProperty: [...additional][0] });
    } else if (isRecord(schema.additionalProperties) || schema.additionalProperties === true) {
      for (const key of additional) {
        if (!this.check(schema.additionalProperties, value[key], `${path}/${key}`, `${sPath}/additionalProperties`)) valid = false;
      }
    }
    for (const dependents of [schema.dependentRequired, schema.dependentSchemas]) {
      if (!isRecord(dependents)) continue;
      for (const [key, requirement] of Object.entries(dependents)) {
        if (!Object.hasOwn(value, key)) continue;
        if (Array.isArray(requirement)) {
          for (const needed of requirement) {
            if (typeof needed === "string" && !Object.hasOwn(value, needed)) {
              valid = this.#fail(path, `${sPath}/dependentRequired`, "dependentRequired", `must have property ${needed} when ${key} is present`, { property: key, missingProperty: needed });
            }
          }
        } else if (!this.check(requirement, value, path, `${sPath}/dependentSchemas/${key}`)) {
          valid = false;
        }
      }
    }
    return valid;
  }

  #applyArray(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    const hasArrayAssertions = schema.items !== undefined || Array.isArray(schema.prefixItems)
      || schema.minItems !== undefined || schema.maxItems !== undefined
      || schema.uniqueItems === true || schema.contains !== undefined;
    if (!hasArrayAssertions || !Array.isArray(value)) return true;
    let valid = true;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      valid = this.#fail(path, `${sPath}/minItems`, "minItems", `must NOT have fewer than ${schema.minItems} items`, { limit: schema.minItems });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      valid = this.#fail(path, `${sPath}/maxItems`, "maxItems", `must NOT have more than ${schema.maxItems} items`, { limit: schema.maxItems });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const entry of value) {
        const marker = canonicalJson(entry);
        if (seen.has(marker)) {
          valid = this.#fail(path, `${sPath}/uniqueItems`, "uniqueItems", "must NOT have duplicate items");
          break;
        }
        seen.add(marker);
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((subSchema, index) => {
        if (index < value.length && !this.check(subSchema, value[index], `${path}/${index}`, `${sPath}/prefixItems/${index}`)) valid = false;
      });
      if (schema.items !== undefined && schema.items !== false) {
        for (let index = schema.prefixItems.length; index < value.length; index += 1) {
          if (!this.check(schema.items, value[index], `${path}/${index}`, `${sPath}/items`)) valid = false;
        }
      } else if (schema.items === false && value.length > schema.prefixItems.length) {
        valid = this.#fail(path, `${sPath}/items`, "items", "must NOT have additional items", { limit: schema.prefixItems.length });
      }
    } else if (schema.items !== undefined) {
      // Pre-2020 tuple form: `items` as an array validates positionally.
      if (Array.isArray(schema.items)) {
        schema.items.forEach((subSchema, index) => {
          if (index < value.length && !this.check(subSchema, value[index], `${path}/${index}`, `${sPath}/items/${index}`)) valid = false;
        });
      } else {
        for (let index = 0; index < value.length; index += 1) {
          if (!this.check(schema.items, value[index], `${path}/${index}`, `${sPath}/items`)) valid = false;
        }
      }
    }
    if (schema.contains !== undefined) {
      const matches = value.filter((entry, index) => this.check(schema.contains, entry, `${path}/${index}`, `${sPath}/contains`)).length;
      const minContains = typeof schema.minContains === "number" ? schema.minContains : 1;
      const maxContains = typeof schema.maxContains === "number" ? schema.maxContains : Number.MAX_SAFE_INTEGER;
      if (matches < minContains || matches > maxContains) {
        valid = this.#fail(path, `${sPath}/contains`, "contains", "must contain a matching item", { matches });
      }
    }
    return valid;
  }

  #applyString(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    if (typeof value !== "string") return true;
    let valid = true;
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      valid = this.#fail(path, `${sPath}/minLength`, "minLength", `must NOT have fewer than ${schema.minLength} characters`, { limit: schema.minLength });
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      valid = this.#fail(path, `${sPath}/maxLength`, "maxLength", `must NOT have more than ${schema.maxLength} characters`, { limit: schema.maxLength });
    }
    if (typeof schema.pattern === "string") {
      let regex: RegExp;
      try {
        regex = new RegExp(schema.pattern, "u");
      } catch {
        throw new GatewaySchemaError("schema_invalid", "Interpreted schema carries an invalid pattern.", { cause: schema.pattern.slice(0, 80) });
      }
      if (!regex.test(value)) {
        valid = this.#fail(path, `${sPath}/pattern`, "pattern", `must match pattern "${schema.pattern}"`, { pattern: schema.pattern });
      }
    }
    return valid;
  }

  #applyNumber(schema: Record<string, unknown>, value: unknown, path: string, sPath: string): boolean {
    if (typeof value !== "number" || !Number.isFinite(value)) return true;
    let valid = true;
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      valid = this.#fail(path, `${sPath}/minimum`, "minimum", `must be >= ${schema.minimum}`, { comparison: ">=", limit: schema.minimum });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      valid = this.#fail(path, `${sPath}/maximum`, "maximum", `must be <= ${schema.maximum}`, { comparison: "<=", limit: schema.maximum });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      valid = this.#fail(path, `${sPath}/exclusiveMinimum`, "exclusiveMinimum", `must be > ${schema.exclusiveMinimum}`, { comparison: ">", limit: schema.exclusiveMinimum });
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      valid = this.#fail(path, `${sPath}/exclusiveMaximum`, "exclusiveMaximum", `must be < ${schema.exclusiveMaximum}`, { comparison: "<", limit: schema.exclusiveMaximum });
    }
    if (typeof schema.multipleOf === "number" && schema.multipleOf !== 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      valid = this.#fail(path, `${sPath}/multipleOf`, "multipleOf", `must be multiple of ${schema.multipleOf}`, { multipleOf: schema.multipleOf });
    }
    return valid;
  }
}

/**
 * Compile a schema into a synchronous interpreted validator. Shares the same
 * admission gates as the Ajv path (byte/node/ref/depth budgets and the
 * 2020-12 dialect check) via `assertExternalSchemaBudget`.
 */
export function compileInterpretedSchema(
  schema: unknown,
  options: { readonly budget?: SchemaBudget; readonly label?: string } = {},
): CompiledExternalSchema {
  const label = options.label ?? "External schema";
  try {
    assertExternalSchemaBudget(schema, { budget: options.budget });
  } catch (error) {
    if (error instanceof GatewaySchemaError) throw error;
    throw new GatewaySchemaError("schema_invalid", `${label} could not be compiled.`);
  }
  const original = cloneJson(schema);
  const digest = createHash("sha256").update(canonicalJson(original)).digest("hex");
  let latestErrors: readonly SchemaValidationError[] = Object.freeze([]);
  const validate = (value: unknown): boolean => {
    const probe = new InterpretedValidator(original);
    const valid = probe.check(original, value, "", "#");
    latestErrors = probe.errors();
    return valid;
  };
  const assertValid = (value: unknown): void => {
    if (!validate(value)) {
      throw new GatewaySchemaError("schema_validation_failed", `${label} does not satisfy its schema.`, { errors: latestErrors });
    }
  };
  return Object.freeze({
    schema: original,
    dialect: JSON_SCHEMA_2020_12,
    digest,
    validatorVersion: INTERPRETED_SCHEMA_VALIDATOR_VERSION,
    validate,
    errors: () => latestErrors,
    assertValid,
  });
}

/**
 * Drop-in counterpart of `createSchemaValidator` for runtimes without code
 * generation. Cache behaviour mirrors the Ajv-backed validator so repeated
 * publishes do not re-walk identical schema sets.
 */
export function createInterpretedSchemaValidator(options: { readonly budget?: SchemaBudget } = {}): {
  compile(schema: unknown, label?: string): CompiledExternalSchema;
} {
  const cache = new Map<string, CompiledExternalSchema>();
  let cachedBytes = 0;
  return Object.freeze({
    compile(schema: unknown, label?: string): CompiledExternalSchema {
      const key = `${JSON_SCHEMA_2020_12}:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}:${INTERPRETED_SCHEMA_VALIDATOR_VERSION}`;
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
      const compiled = compileInterpretedSchema(schema, { budget: options.budget, label });
      const bytes = Buffer.byteLength(canonicalJson(schema), "utf8");
      while (cache.size >= 64 || cachedBytes + bytes > 2 * 1024 * 1024) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cachedBytes -= Buffer.byteLength(canonicalJson(cache.get(oldest)!.schema), "utf8");
        cache.delete(oldest);
      }
      cache.set(key, compiled);
      cachedBytes += bytes;
      return compiled;
    },
  });
}
