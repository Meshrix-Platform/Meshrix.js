import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

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
  readonly assertValid: (value: unknown, signal?: AbortSignal) => void;
}

export interface IsolatedExternalSchema {
  readonly schema: unknown;
  readonly digest: string;
  readonly assertValid: (value: unknown, signal?: AbortSignal) => Promise<void>;
}

interface IsolatedReply {
  readonly valid?: boolean;
  readonly errors?: readonly SchemaValidationError[];
  readonly code?: string;
}

interface IsolationJob {
  readonly schema: unknown;
  readonly value?: unknown;
  readonly validate: boolean;
  readonly signal?: AbortSignal;
  readonly resolve: (result: IsolatedReply) => void;
  readonly reject: (error: unknown) => void;
}

/** Workers keep hostile Ajv compilation and RegExp evaluation off the ingress event loop. */
export class IsolatedSchemaValidator {
  readonly #budget: Required<SchemaBudget>;
  readonly #pending: IsolationJob[] = [];
  readonly #workers = new Set<Worker>();
  readonly #idle: Worker[] = [];
  readonly #active = new Map<Worker, (result?: IsolatedReply, error?: unknown, discard?: boolean) => void>();
  readonly #terminating = new Set<Promise<number>>();
  #closed = false;

  constructor(options: { readonly budget?: SchemaBudget } = {}) {
    this.#budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
  }

  stats(): Readonly<{ workers: number; active: number; queued: number; deadlineTimers: number }> {
    return Object.freeze({ workers: this.#workers.size, active: this.#active.size, queued: this.#pending.length, deadlineTimers: this.#active.size });
  }

  async preflight(schema: unknown, signal?: AbortSignal): Promise<void> {
    this.#inspect(schema);
    await this.#run(schema, undefined, signal, false);
  }

  compile(schema: unknown): IsolatedExternalSchema {
    const original = cloneJson(this.#inspect(schema));
    const digest = createHash("sha256").update(canonicalJson(original)).digest("hex");
    return Object.freeze({ schema: original, digest, assertValid: async (value: unknown, signal?: AbortSignal) => {
      if (schemaByteLength(value) > this.#budget.maxValidationBytes) throw new GatewaySchemaError("validation_budget_exceeded", "Input exceeds the schema validation byte budget.");
      const result = await this.#run(original, value, signal);
      if (result.valid !== true) throw new GatewaySchemaError("schema_validation_failed", "Value does not satisfy its schema.", { errors: result.errors ?? [] });
    } });
  }

  #inspect(schema: unknown): unknown {
    inspectBudget(schema, this.#budget);
    if (schemaByteLength(schema) > this.#budget.maxBytes) throw new GatewaySchemaError("schema_budget_exceeded", "External schema exceeds the byte budget.");
    schemaDialect(schema);
    return schema;
  }

  #run(schema: unknown, value: unknown, signal?: AbortSignal, validate = true): Promise<IsolatedReply> {
    if (this.#closed) return Promise.reject(new GatewaySchemaError("schema_worker_closed", "Schema isolation has closed."));
    if (signal?.aborted) return Promise.reject(new GatewaySchemaError("schema_validation_aborted", "Schema work was cancelled."));
    if (this.#active.size + this.#pending.length >= 72) return Promise.reject(new GatewaySchemaError("schema_worker_capacity", "Schema isolation capacity is exhausted."));
    return new Promise<IsolatedReply>((resolve, reject) => { this.#pending.push({ schema, value, signal, validate, resolve, reject }); this.#pump(); });
  }

  #discard(worker: Worker): void {
    if (!this.#workers.delete(worker)) return;
    const idle = this.#idle.indexOf(worker);
    if (idle >= 0) this.#idle.splice(idle, 1);
    const stopping = worker.terminate();
    this.#terminating.add(stopping);
    const finished = () => { this.#terminating.delete(stopping); this.#pump(); };
    void stopping.then(finished, finished);
  }

  #pump(): void {
    while (!this.#closed && this.#pending.length > 0 && (this.#idle.length > 0 || this.#workers.size + this.#terminating.size < 8)) {
      const job = this.#pending.shift()!;
      if (job.signal?.aborted) { job.reject(new GatewaySchemaError("schema_validation_aborted", "Schema work was cancelled.")); continue; }
      let worker: Worker;
      if (this.#idle.length > 0) worker = this.#idle.pop()!;
      else {
        const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./isolated-worker.ts" : "./isolated-worker.js", import.meta.url);
        // Never inherit parent `-e`/`--input-type` or instrumentation arguments:
        // Worker has a file entry and must run independently of caller CLI flags.
        try { worker = new Worker(workerUrl, { execArgv: [] }); }
        catch (error) { job.reject(error); continue; }
        this.#workers.add(worker);
        worker.on("message", (result: IsolatedReply) => this.#active.get(worker)?.(result));
        worker.on("error", (error) => { this.#active.get(worker)?.(undefined, error, true); this.#discard(worker); });
        worker.on("exit", (code) => {
          if (code !== 0) this.#active.get(worker)?.(undefined, new GatewaySchemaError("schema_worker_lost", "Schema worker exited before completion."), true);
          this.#workers.delete(worker);
          const idle = this.#idle.indexOf(worker);
          if (idle >= 0) this.#idle.splice(idle, 1);
          this.#pump();
        });
      }
      worker.ref();
      let settled = false;
      const finish = (result?: IsolatedReply, error?: unknown, discard = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.signal?.removeEventListener("abort", aborted);
        this.#active.delete(worker);
        if (discard || this.#closed) this.#discard(worker);
        else { worker.unref(); this.#idle.push(worker); }
        if (error) job.reject(error);
        else if (result?.code) job.reject(new GatewaySchemaError(result.code, "External schema was rejected in isolation."));
        else job.resolve(result ?? {});
        this.#pump();
      };
      const aborted = () => finish(undefined, new GatewaySchemaError("schema_validation_aborted", "Schema work was cancelled."), true);
      const timer = setTimeout(() => finish(undefined, new GatewaySchemaError("schema_execution_timeout", "External schema exceeded its execution deadline."), true), 750);
      this.#active.set(worker, finish);
      job.signal?.addEventListener("abort", aborted, { once: true });
      try { worker.postMessage({ schema: job.schema, value: job.value, validate: job.validate, digest: createHash("sha256").update(canonicalJson(job.schema)).digest("hex") }); }
      catch { finish(undefined, new GatewaySchemaError("schema_validation_invalid", "Schema input could not be isolated."), true); }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#pending.splice(0)) job.reject(new GatewaySchemaError("schema_worker_closed", "Schema isolation has closed."));
    for (const finish of [...this.#active.values()]) finish(undefined, new GatewaySchemaError("schema_worker_closed", "Schema isolation has closed."), true);
    for (const worker of [...this.#idle]) this.#discard(worker);
    await Promise.allSettled([...this.#terminating]);
    this.#workers.clear();
    this.#idle.length = 0;
  }
}

export function createIsolatedSchemaValidator(options: { readonly budget?: SchemaBudget } = {}): IsolatedSchemaValidator {
  return new IsolatedSchemaValidator(options);
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
  let bytes = 0;
  const pending: Array<{ value: unknown; depth: number; path: string }> = [{ value: schema, depth: 0, path: "$" }];
  while (pending.length > 0) {
    const { value, depth, path } = pending.pop()!;
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
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
      bytes += Buffer.byteLength(key, "utf8") + 4;
      pending.push({ value: child, depth: depth + 1, path: `${path}.${key}` });
    }
  }
}

function schemaDialect(schema: unknown): string {
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
  inspectBudget(schema, budget);
  const bytes = schemaByteLength(schema);
  if (bytes > budget.maxBytes) {
    throw new GatewaySchemaError("schema_budget_exceeded", `${options.label ?? "External schema"} exceeds the byte budget.`, { bytes, maxBytes: budget.maxBytes });
  }
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
  let cachedBytes = 0;
  return Object.freeze({
    compile(schema: unknown, label?: string): CompiledExternalSchema {
      inspectBudget(schema, budget);
      const bytes = schemaByteLength(schema);
      const dialect = schemaDialect(schema);
      const key = `${dialect}:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}:${EXTERNAL_SCHEMA_VALIDATOR_VERSION}:${JSON.stringify(budget)}`;
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
      const compiled = compileExternalSchema(schema, { budget, label });
      if (bytes <= budget.maxBytes && bytes <= 2 * 1024 * 1024) {
        while (cache.size >= 64 || cachedBytes + bytes > 2 * 1024 * 1024) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cachedBytes -= schemaByteLength(cache.get(oldest)!.schema);
          cache.delete(oldest);
        }
        cache.set(key, compiled);
        cachedBytes += bytes;
      }
      return compiled;
    }
  });
}
