/**
 * OperationRouteIndex — Compiles HTTP and RPC route indices from operation registry.
 *
 * Builds:
 *  - httpIndex: Map<HTTPMethod, RadixTrie<RouteNode>>
 *  - rpcIndex: Map<rpcMethod, Operation>
 *  - operationById: Map<operationId, Operation>
 *  - capabilityByOperationId: Map<operationId, Capability>
 *
 * Replaces linear findHttpOperation / findRpcOperation scans.
 * Detects: duplicate paths, ambiguous params, duplicate RPC methods, missing target handlers.
 *
 * Performance: 1000+ operations lookup p95 < 1ms.
 *
 * @module server-runtime/routing/operation-route-index
 */

import crypto from "node:crypto";
import { RadixPathTrie } from "./radix-path-trie.ts";

const VALID_HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);
const ROUTE_INDEX_INSTRUMENTATION_SCHEMA = "v0.0.1:server-runtime:operation-route-index-instrumentation-1";
let routeIndexSnapshotBuildCount = 0;

type UnknownRecord = Record<string, unknown>;

export interface OperationDefinition extends UnknownRecord {
  id: string;
  http?: { method?: string | string[]; path?: string } & UnknownRecord;
  rpc?: { method?: string } & UnknownRecord;
  capability?: UnknownRecord;
  risk?: string;
  safety?: { risk?: string };
  requiredScopes?: string[];
}

interface RouteNode {
  operation: OperationDefinition;
  path: string;
  method: string;
  httpConfig: NonNullable<OperationDefinition["http"]>;
}

interface RouteConflict {
  method: string;
  path: string;
  conflictPath: string;
  reason: string;
}

interface RouteWarning {
  operationId: string;
  method: string;
  reason: string;
}

interface HttpRouteSummary {
  method: string;
  path: string;
  operationId: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as UnknownRecord;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function operationsRevision(operations: readonly unknown[] = []): string {
  return crypto.createHash("sha256").update(stableStringify(operations)).digest("hex");
}

export function getRouteIndexRefactorInstrumentation() {
  return {
    schemaVersion: ROUTE_INDEX_INSTRUMENTATION_SCHEMA,
    snapshotBuildCount: routeIndexSnapshotBuildCount
  };
}

function immutableSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(immutableSnapshot(item, seen));
    return Object.freeze(clone) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const clone: UnknownRecord = {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) {
    clone[key] = immutableSnapshot(child, seen);
  }
  return Object.freeze(clone) as T;
}

export class OperationRouteIndex {
  conflicts: RouteConflict[];
  operations: readonly OperationDefinition[];
  strict: boolean;
  revision: string;
  warnings: RouteWarning[];
  #httpIndex = new Map<string, RadixPathTrie<RouteNode>>();
  #httpRoutes: HttpRouteSummary[] = [];
  #rpcIndex = new Map<string, OperationDefinition>();
  #operationById = new Map<string, OperationDefinition>();
  #capabilityByOperationId = new Map<string, UnknownRecord>();

  /**
   * @param {Array} operations - Array of operation definitions from the registry
   * @param {object} [options]
   * @param {boolean} [options.strict=false] - If true, throw on conflicts
   * @param {string} [options.revision] - Exact registry revision this snapshot is built from
   */
  constructor(operations: readonly OperationDefinition[] = [], options: { strict?: boolean; revision?: string } = {}) {
    if (!Array.isArray(operations)) {
      throw new TypeError("Operation route index requires an operation array.");
    }
    this.operations = immutableSnapshot(operations);
    this.strict = Boolean(options.strict);
    this.revision = String(
      options.revision || operationsRevision(operations)
    );

    /** @type {Array<{path: string, conflictPath: string, reason: string}>} */
    this.conflicts = [];

    /** @type {Array<{operationId: string, method: string, reason: string}>} */
    this.warnings = [];

    this._build();
    routeIndexSnapshotBuildCount += 1;
    this.conflicts = Object.freeze([...this.conflicts]) as RouteConflict[];
    this.warnings = Object.freeze([...this.warnings]) as RouteWarning[];
    this.#httpRoutes = Object.freeze(this.#httpRoutes.map((route) => Object.freeze(route))) as HttpRouteSummary[];
  }

  getSnapshot() {
    return Object.freeze({
      schemaVersion: "v0.0.1:server-runtime:operation-route-snapshot-1",
      revision: this.revision,
      size: this.#operationById.size,
      httpRouteCount: this.#httpRoutes.length,
      rpcMethodCount: this.#rpcIndex.size
    });
  }

  getRefactorInstrumentation() {
    return getRouteIndexRefactorInstrumentation();
  }

  /**
   * Find an HTTP operation by method and path.
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} path - URL path
   * @returns {{ operation: object, params: Record<string, string> } | null}
   */
  findHttpOperation(method?: unknown, path?: unknown): { operation: OperationDefinition; params: Record<string, string> } | null {
    if (typeof method !== "string" || !method) return null;
    const trie = this.#httpIndex.get(method.toUpperCase());
    if (!trie) return null;

    const pathname = _pathnameFrom(path);
    const result = trie.lookup(pathname);
    if (!result) return null;

    return {
      operation: result.value.operation,
      params: result.params || {},
    };
  }

  /**
   * Find a JSON-RPC operation by method name.
   * @param {string} rpcMethod - RPC method name
   * @returns {object | null}
   */
  findRpcOperation(rpcMethod?: unknown): OperationDefinition | null {
    return typeof rpcMethod === "string" ? this.#rpcIndex.get(rpcMethod) || null : null;
  }

  /**
   * Get an operation by its ID.
   * @param {string} operationId
   * @returns {object | undefined}
   */
  getOperationById(operationId?: unknown): OperationDefinition | undefined {
    return typeof operationId === "string" ? this.#operationById.get(operationId) : undefined;
  }

  /**
   * Get capability for an operation.
   * @param {string} operationId
   * @returns {object | undefined}
   */
  getCapabilityForOperation(operationId?: unknown): UnknownRecord | undefined {
    return typeof operationId === "string"
      ? this.#capabilityByOperationId.get(operationId)
      : undefined;
  }

  /**
   * List all HTTP paths with their methods.
   * @returns {Array<{method: string, path: string, operationId: string}>}
   */
  listHttpRoutes(): HttpRouteSummary[] {
    return this.#httpRoutes.map((route) => ({ ...route }));
  }

  /**
   * List all RPC methods.
   * @returns {Array<{rpcMethod: string, operationId: string}>}
   */
  listRpcMethods(): Array<{ rpcMethod: string; operationId: string }> {
    const methods: Array<{ rpcMethod: string; operationId: string }> = [];
    for (const [rpcMethod, operation] of this.#rpcIndex) {
      methods.push({
        rpcMethod,
        operationId: operation?.id || "",
      });
    }
    return methods;
  }

  /**
   * Get the total number of indexed operations.
   */
  get size(): number {
    return this.#operationById.size;
  }

  // --- Private ---

  _build(): void {
    for (const operation of this.operations) {
      this._indexOperation(operation);
    }

    // Detect trie conflicts
    for (const [method, trie] of this.#httpIndex) {
      const trieConflicts = trie.detectConflicts();
      for (const c of trieConflicts) {
        this.conflicts.push({
          ...c,
          method,
        });
      }
    }

    if (this.strict && this.conflicts.length > 0) {
      const msgs = this.conflicts.map(
        (c) => `[${c.method}] ${c.path} conflicts with ${c.conflictPath}: ${c.reason}`
      );
      throw new Error(`Route conflicts detected:\n${msgs.join("\n")}`);
    }
  }

  _indexOperation(operation: OperationDefinition): void {
    const opId = typeof operation?.id === "string" ? operation.id : "";
    if (!opId || opId !== opId.trim()) {
      this.conflicts.push({
        method: "OPERATION",
        path: opId,
        conflictPath: "",
        reason: "Operation ID is required and cannot contain surrounding whitespace",
      });
      return;
    }

    // Register by ID
    if (this.#operationById.has(opId)) {
      this.conflicts.push({
        method: "OPERATION",
        path: opId,
        conflictPath: opId,
        reason: "Duplicate operation ID",
      });
      return;
    }
    this.#operationById.set(opId, operation);
    this.#capabilityByOperationId.set(opId, operation.capability || {
      id: `cap:api:${opId}`,
      operationId: opId,
      kind: "api",
      risk: operation.risk || operation.safety?.risk || "read_only",
      requiredScopes: operation.requiredScopes || [],
    });

    // Register HTTP routes
    if (operation.http) {
      this._indexHttpOperation(opId, operation);
    }

    // Register RPC methods
    if (operation.rpc) {
      this._indexRpcOperation(opId, operation);
    }
  }

  _indexHttpOperation(opId: string, operation: OperationDefinition): void {
    const http = operation.http!;
    const rawMethods = Array.isArray(http.method) ? http.method : [http.method];
    const path = typeof http.path === "string" ? http.path : "";
    if (rawMethods.length === 0 || !path || path !== path.trim()) {
      this.conflicts.push({
        method: "HTTP",
        path,
        conflictPath: "",
        reason: "HTTP method and path are required",
      });
      return;
    }

    for (const rawMethod of rawMethods) {
      const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "";
      if (!VALID_HTTP_METHODS.has(method)) {
        this.conflicts.push({
          method,
          path,
          conflictPath: "",
          reason: `Invalid HTTP method for operation ${opId}`,
        });
        continue;
      }

      if (!this.#httpIndex.has(method)) {
        this.#httpIndex.set(method, new RadixPathTrie());
      }

      const trie = this.#httpIndex.get(method)!;
      const routeNode: RouteNode = {
        operation,
        path,
        method,
        httpConfig: http,
      };

      try {
        const inserted = trie.insert(path, routeNode);
        if (!inserted) {
          this.conflicts.push({
            method,
            path,
            conflictPath: path,
            reason: "duplicate_path",
          });
        } else {
          this.#httpRoutes.push({ method, path, operationId: opId });
        }
      } catch (err: unknown) {
        this.conflicts.push({
          method,
          path,
          conflictPath: "",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  _indexRpcOperation(opId: string, operation: OperationDefinition): void {
    const rpc = operation.rpc!;
    const rpcMethod = typeof rpc.method === "string" ? rpc.method : "";
    if (!rpcMethod || rpcMethod !== rpcMethod.trim()) {
      this.conflicts.push({
        method: "RPC",
        path: rpcMethod,
        conflictPath: "",
        reason: `RPC method is required for operation ${opId}`,
      });
      return;
    }

    if (this.#rpcIndex.has(rpcMethod)) {
      this.conflicts.push({
        method: "RPC",
        path: rpcMethod,
        conflictPath: rpcMethod,
        reason: "Duplicate RPC method",
      });
      return;
    }
    this.#rpcIndex.set(rpcMethod, operation);
  }
}

/**
 * Create an OperationRouteIndex from SERVER_API_OPERATIONS.
 * @param {Array} operations - Operation definitions
 * @param {object} [options]
 * @returns {OperationRouteIndex}
 */
export function createOperationRouteIndex(
  operations: readonly OperationDefinition[] = [],
  options: { strict?: boolean; revision?: string } = {}
): OperationRouteIndex {
  return new OperationRouteIndex(operations, options);
}

function _pathnameFrom(path?: unknown): string {
  const raw = String(path || "/");
  const queryStart = raw.indexOf("?");
  return queryStart === -1 ? raw : raw.slice(0, queryStart) || "/";
}
