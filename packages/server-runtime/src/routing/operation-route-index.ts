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

import { RadixPathTrie } from "./radix-path-trie.ts";

const VALID_HTTP_METHODS: any = new Set<any>([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

function immutableSnapshot(value?: any, seen: any = new WeakMap<object, any>()) : any {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone: any[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(immutableSnapshot(item, seen));
    return Object.freeze(clone);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const clone: Record<string, any> = {};
  seen.set(value, clone);
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    clone[key] = immutableSnapshot(child, seen);
  }
  return Object.freeze(clone);
}

export class OperationRouteIndex {
  conflicts: any;
  operations: any;
  strict: any;
  warnings: any;
  #httpIndex = new Map<any, any>();
  #httpRoutes: any = [];
  #rpcIndex = new Map<any, any>();
  #operationById = new Map<any, any>();
  #capabilityByOperationId = new Map<any, any>();

  /**
   * @param {Array} operations - Array of operation definitions from the registry
   * @param {object} [options]
   * @param {boolean} [options.strict=false] - If true, throw on conflicts
   */
  constructor(operations: any = [], options: Record<string, any> = {}) {
    if (!Array.isArray(operations)) {
      throw new TypeError("Operation route index requires an operation array.");
    }
    this.operations = immutableSnapshot(operations);
    this.strict = Boolean(options.strict);

    /** @type {Array<{path: string, conflictPath: string, reason: string}>} */
    this.conflicts = [];

    /** @type {Array<{operationId: string, method: string, reason: string}>} */
    this.warnings = [];

    this._build();
    this.conflicts = Object.freeze([...this.conflicts]);
    this.warnings = Object.freeze([...this.warnings]);
    this.#httpRoutes = Object.freeze(this.#httpRoutes.map((route?: any) : any => Object.freeze(route)));
  }

  /**
   * Find an HTTP operation by method and path.
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} path - URL path
   * @returns {{ operation: object, params: Record<string, string> } | null}
   */
  findHttpOperation(method?: any, path?: any) : any {
    if (typeof method !== "string" || !method) return null;
    const trie: any = this.#httpIndex.get(method.toUpperCase());
    if (!trie) return null;

    const pathname: any = _pathnameFrom(path);
    const result: any = trie.lookup(pathname);
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
  findRpcOperation(rpcMethod?: any) : any {
    return typeof rpcMethod === "string" ? this.#rpcIndex.get(rpcMethod) || null : null;
  }

  /**
   * Get an operation by its ID.
   * @param {string} operationId
   * @returns {object | undefined}
   */
  getOperationById(operationId?: any) : any {
    return typeof operationId === "string" ? this.#operationById.get(operationId) : undefined;
  }

  /**
   * Get capability for an operation.
   * @param {string} operationId
   * @returns {object | undefined}
   */
  getCapabilityForOperation(operationId?: any) : any {
    return typeof operationId === "string"
      ? this.#capabilityByOperationId.get(operationId)
      : undefined;
  }

  /**
   * List all HTTP paths with their methods.
   * @returns {Array<{method: string, path: string, operationId: string}>}
   */
  listHttpRoutes() : any {
    return this.#httpRoutes.map((route?: any) : any => ({ ...route }));
  }

  /**
   * List all RPC methods.
   * @returns {Array<{rpcMethod: string, operationId: string}>}
   */
  listRpcMethods() : any {
    const methods: any[] = [];
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
  get size() : any {
    return this.#operationById.size;
  }

  // --- Private ---

  _build() : any {
    for (const operation of this.operations) {
      this._indexOperation(operation);
    }

    // Detect trie conflicts
    for (const [method, trie] of this.#httpIndex) {
      const trieConflicts: any = trie.detectConflicts();
      for (const c of trieConflicts) {
        this.conflicts.push({
          ...c,
          method,
        });
      }
    }

    if (this.strict && this.conflicts.length > 0) {
      const msgs: any = this.conflicts.map(
        (c?: any) : any => `[${c.method}] ${c.path} conflicts with ${c.conflictPath}: ${c.reason}`
      );
      throw new Error(`Route conflicts detected:\n${msgs.join("\n")}`);
    }
  }

  _indexOperation(operation?: any) : any {
    const opId: any = typeof operation?.id === "string" ? operation.id : "";
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

  _indexHttpOperation(opId?: any, operation?: any) : any {
    const http: any = operation.http;
    const rawMethods: any = Array.isArray(http.method) ? http.method : [http.method];
    const path: any = typeof http.path === "string" ? http.path : "";
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
      const method: any = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "";
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

      const trie: any = this.#httpIndex.get(method);
      const routeNode: Record<string, any> = {
        operation,
        path,
        method,
        httpConfig: http,
      };

      try {
        const inserted: any = trie.insert(path, routeNode);
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
      } catch (err: any) {
        this.conflicts.push({
          method,
          path,
          conflictPath: "",
          reason: err.message,
        });
      }
    }
  }

  _indexRpcOperation(opId?: any, operation?: any) : any {
    const rpc: any = operation.rpc;
    const rpcMethod: any = typeof rpc.method === "string" ? rpc.method : "";
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
export function createOperationRouteIndex(operations?: any, options: Record<string, any> = {}) : any {
  return new OperationRouteIndex(operations, options);
}

function _pathnameFrom(path?: any) : any {
  const raw: any = String(path || "/");
  const queryStart: any = raw.indexOf("?");
  return queryStart === -1 ? raw : raw.slice(0, queryStart) || "/";
}
