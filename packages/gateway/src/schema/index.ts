import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";

import { cloneJson, canonicalJson } from "../utils.ts";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;
export const EXTERNAL_SCHEMA_VALIDATOR_VERSION = "ajv-2020-12:8.20.0" as const;

export interface SchemaBudget {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxRefs?: number;
  readonly maxDepth?: number;
  readonly maxValidationBytes?: number;
}

export interface SchemaValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export class GatewaySchemaError extends Error {
  readonly code: string;
  readonly status = 400;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "GatewaySchemaError";
    this.code = code;
    this.details = details;
  }
}

export interface CompiledExternalSchema {
  readonly schema: unknown;
  readonly dialect: string;
  readonly digest: string;
  readonly validatorVersion: string;
  readonly validate: (value: unknown) => boolean;
  readonly errors: () => readonly SchemaValidationError[];
  readonly assertValid: (value: unknown) => void;
}

const DEFAULT_BUDGET: Required<SchemaBudget> = Object.freeze({
  maxBytes: 512 * 1024,
  maxNodes: 8_192,
  maxRefs: 1_024,
  maxDepth: 256,
  maxValidationBytes: 8 * 1024 * 1024
});

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function schemaByteLength(schema: unknown): number {
  return Buffer.byteLength(canonicalJson(schema), "utf8");
}

function inspectBudget(schema: unknown, budget: Required<SchemaBudget>): void {
  const seen = new Set<object>();
  let nodes = 0;
  let refs = 0;
  const visit = (value: unknown, depth: number, path: string): void => {
    if (typeof value === "boolean" || value === null || typeof value !== "object") return;
    if (depth > budget.maxDepth) {
      throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the structural depth budget.", { path, maxDepth: budget.maxDepth });
    }
    if (seen.has(value)) return;
    seen.add(value);
    nodes += 1;
    if (nodes > budget.maxNodes) {
      throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the node budget.", { maxNodes: budget.maxNodes });
    }
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "$ref")) {
      refs += 1;
      if (refs > budget.maxRefs) {
        throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the reference budget.", { maxRefs: budget.maxRefs });
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, depth + 1, `${path}.${key}`);
  };
  visit(schema, 0, "$");
}

function schemaDialect(schema: unknown): string {
  if (!isSchemaObject(schema) || schema.$schema === undefined) return JSON_SCHEMA_2020_12;
  if (typeof schema.$schema !== "string" || schema.$schema !== JSON_SCHEMA_2020_12) {
    throw new GatewaySchemaError("schema_dialect_unsupported", "Only JSON Schema 2020-12 is supported for external schemas.", { dialect: schema.$schema });
  }
  return schema.$schema;
}

function normalizeErrors(errors: readonly ErrorObject[] | null | undefined): readonly SchemaValidationError[] {
  return Object.freeze((errors ?? []).map((error) => Object.freeze({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
    params: Object.freeze({ ...error.params })
  })));
}

function makeAjv(): Ajv2020 {
  return new Ajv2020({
    strict: false,
    strictSchema: true,
    strictTypes: false,
    allErrors: true,
    addUsedSchema: false,
    validateFormats: false,
    allowUnionTypes: true
  });
}

export function compileExternalSchema(schema: unknown, options: { readonly budget?: SchemaBudget; readonly label?: string } = {}): CompiledExternalSchema {
  const budget: Required<SchemaBudget> = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
  const bytes = schemaByteLength(schema);
  if (bytes > budget.maxBytes) {
    throw new GatewaySchemaError("schema_budget_exceeded", `${options.label ?? "External schema"} exceeds the byte budget.`, { bytes, maxBytes: budget.maxBytes });
  }
  inspectBudget(schema, budget);
  const dialect = schemaDialect(schema);
  const original = cloneJson(schema);
  const schemaDigest = createHash("sha256").update(canonicalJson(original)).digest("hex");
  const ajv = makeAjv();
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(original as AnySchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unresolved = /can't resolve reference|reference .* not found|ref .* not found/iu.test(message);
    const unsupportedKeyword = /unknown keyword|unknown vocabulary/iu.test(message);
    if (unsupportedKeyword) {
      throw new GatewaySchemaError("schema_keyword_unsupported", `${options.label ?? "External schema"} uses an unsupported JSON Schema keyword or vocabulary.`, { cause: message });
    }
    throw new GatewaySchemaError(unresolved ? "schema_reference_unresolved" : "schema_invalid", `${options.label ?? "External schema"} could not be compiled.`, { cause: message });
  }
  let latestErrors: readonly SchemaValidationError[] = Object.freeze([]);
  const validate = (value: unknown): boolean => {
    if (schemaByteLength(value) > budget.maxValidationBytes) {
      throw new GatewaySchemaError("validation_budget_exceeded", "Input exceeds the schema validation byte budget.", { maxValidationBytes: budget.maxValidationBytes });
    }
    const valid = Boolean(validator(value));
    latestErrors = normalizeErrors(validator.errors);
    return valid;
  };
  const assertValid = (value: unknown): void => {
    if (!validate(value)) {
      throw new GatewaySchemaError("schema_validation_failed", `${options.label ?? "Value"} does not satisfy its schema.`, { errors: latestErrors });
    }
  };
  return Object.freeze({
    schema: original,
    dialect,
    digest: schemaDigest,
    validatorVersion: EXTERNAL_SCHEMA_VALIDATOR_VERSION,
    validate,
    errors: () => latestErrors,
    assertValid
  });
}

export function createSchemaValidator(options: { readonly budget?: SchemaBudget } = {}): {
  compile(schema: unknown, label?: string): CompiledExternalSchema;
} {
  const cache = new Map<string, CompiledExternalSchema>();
  const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
  return Object.freeze({
    compile(schema: unknown, label?: string): CompiledExternalSchema {
      const dialect = schemaDialect(schema);
      const key = `${dialect}:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}:${EXTERNAL_SCHEMA_VALIDATOR_VERSION}:${JSON.stringify(budget)}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const compiled = compileExternalSchema(schema, { budget, label });
      cache.set(key, compiled);
      return compiled;
    }
  });
}
