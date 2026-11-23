import { canonicalJson } from "../utils.ts";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

export interface SchemaBudget {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxRefs?: number;
  readonly maxDepth?: number;
  readonly maxValidationBytes?: number;
  readonly executionDeadlineMs?: number;
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
  readonly assertValid: (value: unknown, signal?: AbortSignal) => void;
}

export const DEFAULT_BUDGET: Required<SchemaBudget> = Object.freeze({
  maxBytes: 512 * 1024,
  maxNodes: 8_192,
  maxRefs: 1_024,
  maxDepth: 256,
  maxValidationBytes: 8 * 1024 * 1024,
  executionDeadlineMs: 750
});

const textEncoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function schemaByteLength(schema: unknown): number {
  return utf8ByteLength(canonicalJson(schema));
}

export function inspectBudget(schema: unknown, budget: Required<SchemaBudget>): void {
  const seen = new Set<object>();
  let nodes = 0;
  let refs = 0;
  let bytes = 0;
  const pending: Array<{ value: unknown; depth: number; path: string }> = [{ value: schema, depth: 0, path: "$" }];
  while (pending.length > 0) {
    const { value, depth, path } = pending.pop()!;
    if (typeof value === "string") bytes += utf8ByteLength(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) bytes += 8;
    if (bytes > budget.maxBytes) throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the byte budget.", { maxBytes: budget.maxBytes });
    if (value === null || typeof value !== "object") continue;
    if (depth > budget.maxDepth) {
      throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the structural depth budget.", { path, maxDepth: budget.maxDepth });
    }
    if (seen.has(value)) throw new GatewaySchemaError("schema_invalid", "External schema contains repeated or cyclic object references.");
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
    for (const [key, child] of Object.entries(record)) {
      bytes += utf8ByteLength(key) + 4;
      pending.push({ value: child, depth: depth + 1, path: `${path}.${key}` });
    }
  }
}

export function schemaDialect(schema: unknown): string {
  if (!isSchemaObject(schema) || schema.$schema === undefined) return JSON_SCHEMA_2020_12;
  if (typeof schema.$schema !== "string" || schema.$schema !== JSON_SCHEMA_2020_12) {
    throw new GatewaySchemaError("schema_dialect_unsupported", "Only JSON Schema 2020-12 is supported for external schemas.", { dialect: schema.$schema });
  }
  return schema.$schema;
}

/** Bounded synchronous admission only; untrusted compilation is performed in a Worker. */
export function assertExternalSchemaBudget(schema: unknown, options: { readonly budget?: SchemaBudget } = {}): void {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
  inspectBudget(schema, budget);
  if (schemaByteLength(schema) > budget.maxBytes) throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the byte budget.");
  schemaDialect(schema);
}
