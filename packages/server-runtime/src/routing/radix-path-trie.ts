/**
 * RadixPathTrie — A radix-tree-based path trie for HTTP route matching.
 *
 * Supports:
 *  - Static segments: /api/workspace/list
 *  - Named parameters: /api/workspace/:workspaceId/file/:fileId
 *  - Wildcard (catch-all): /static/*
 *  - Conflict detection for duplicate paths and ambiguous parameters.
 *
 * Performance target: 1000+ routes, p95 lookup < 1ms.
 *
 * @module server-runtime/routing/radix-path-trie
 */

const PATH_SEGMENT: any = Symbol("path_segment");
const PARAM_SEGMENT: any = Symbol("param_segment");
const WILDCARD_SEGMENT: any = Symbol("wildcard_segment");
const UNRESERVED_CHARACTER_PATTERN: any = /^[A-Za-z0-9._~-]$/u;
const CONTROL_CHARACTER_PATTERN: any = /[\u0000-\u001F\u007F]/u;
export const ROUTE_PARAMETER_MAX_BYTES: any = 1_024;
export const ROUTE_WILDCARD_MAX_BYTES: any = 8_192;

function normalizePercentEncodedUnreserved(segment?: any) : any {
  return segment.replace(/%([0-9A-Fa-f]{2})/gu, (encoded?: any, hex?: any) : any => {
    const character: any = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_CHARACTER_PATTERN.test(character)
      ? character
      : `%${hex.toUpperCase()}`;
  });
}

export function normalizeRoutingPathname(path?: any) : any {
  let pathname: any = String(path || "/").trim().split("?", 1)[0].split("#", 1)[0];
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  const segments: any = pathname.split("/").filter(Boolean);
  const normalized: any[] = [];
  for (const segment of segments) {
    let decoded: any;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (CONTROL_CHARACTER_PATTERN.test(decoded)) return null;
    normalized.push(normalizePercentEncodedUnreserved(segment));
  }
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

class RadixTrieNode {
  children: any;
  kind: any;
  paramChild: any;
  paramName: any;
  paramNames: any;
  segment: any;
  value: any;
  wildcardChild: any;
  constructor(segment: any = "", kind: any = PATH_SEGMENT) {
    this.segment = segment;
    this.kind = kind;
    this.children = new Map<any, any>();
    this.paramChild = null;
    this.wildcardChild = null;
    this.value = null;
    this.paramName = null;
    this.paramNames = [];
    if (kind === PARAM_SEGMENT) {
      this.paramName = segment.startsWith(":") ? segment.slice(1) : segment;
    }
  }
}

export class RadixPathTrie {
  _paths: any;
  _size: any;
  root: any;
  constructor() {
    this.root = new RadixTrieNode("/", PATH_SEGMENT);
    this._size = 0;
    this._paths = new Set<any>();
  }

  get size() : any {
    return this._size;
  }

  /**
   * Insert a path with associated value.
   * @param {string} path - The URL path pattern (e.g., "/api/workspace/:id")
   * @param {*} value - The value to store at this path
   * @returns {boolean} true if inserted, false if duplicate
   * @throws {Error} if path conflicts with existing route
   */
  insert(path?: any, value?: any) : any {
    const normalized: any = normalizeRoutingPathname(path);
    if (normalized === null) {
      throw new Error("Route path contains invalid encoding or control characters.");
    }
    if (this._paths.has(normalized)) {
      return false;
    }

    const segments: any = this._parseSegments(normalized);
    this._validateSegments(segments, normalized);

    let node: any = this.root;
    const paramNames: any[] = [];
    for (const segment of segments) {
      const kind: any = this._segmentKind(segment);
      if (kind === WILDCARD_SEGMENT) {
        if (!node.wildcardChild) {
          node.wildcardChild = new RadixTrieNode(segment, WILDCARD_SEGMENT);
        }
        node = node.wildcardChild;
      } else if (kind === PARAM_SEGMENT) {
        paramNames.push(segment.startsWith(":") ? segment.slice(1) : segment);
        if (!node.paramChild) {
          node.paramChild = new RadixTrieNode(segment, PARAM_SEGMENT);
        }
        node = node.paramChild;
      } else {
        if (!node.children.has(segment)) {
          node.children.set(segment, new RadixTrieNode(segment, PATH_SEGMENT));
        }
        node = node.children.get(segment);
      }
    }

    if (node.value !== null) {
      throw new Error(`Duplicate path: "${normalized}" already has a value`);
    }

    node.value = value;
    node.paramNames = paramNames;
    this._size++;
    this._paths.add(normalized);
    return true;
  }

  /**
   * Look up a concrete path and return { value, params } or null.
   * @param {string} path - The concrete URL path (e.g., "/api/workspace/abc123/file/def456")
   * @returns {{ value: *, params: Record<string, string> } | null}
   */
  lookup(path?: any) : any {
    const normalized: any = normalizeRoutingPathname(path);
    if (normalized === null) return null;
    const segments: any = normalized.split("/").filter(Boolean);
    return this._lookup(this.root, segments, 0, []);
  }

  /**
   * Detect conflicts: returns array of { path, conflictPath, reason }.
   */
  detectConflicts() : any {
    // Duplicate concrete patterns and equivalent parameter shapes are rejected
    // during insertion. Static, parameter, and wildcard siblings are valid and
    // are resolved deterministically in that order.
    return [];
  }

  /**
   * Return all stored path patterns.
   */
  paths() : any {
    return [...this._paths];
  }

  // --- private ---

  _parseSegments(normalizedPath?: any) : any {
    if (normalizedPath === "/") return [];
    return normalizedPath.split("/").filter(Boolean);
  }

  _segmentKind(segment?: any) : any {
    if (segment === "*" || segment === "**") return WILDCARD_SEGMENT;
    if (segment.startsWith(":")) return PARAM_SEGMENT;
    return PATH_SEGMENT;
  }

  _validateSegments(segments?: any, fullPath?: any) : any {
    for (let i: any = 0; i < segments.length; i++) {
      const segment: any = segments[i];
      const kind: any = this._segmentKind(segment);
      if (kind === WILDCARD_SEGMENT) {
        if (i !== segments.length - 1) {
          throw new Error(`Wildcard must be the final segment in path: "${fullPath}"`);
        }
        continue;
      }
      if (kind === PARAM_SEGMENT) {
        const paramName: any = segment.startsWith(":") ? segment.slice(1) : segment;
        if (!paramName) {
          throw new Error(`Parameter name is required in path: "${fullPath}"`);
        }
      }
    }
  }

  _lookup(node?: any, segments?: any, index?: any, paramValues?: any) : any {
    if (index >= segments.length) {
      if (node.value !== null) {
        return {
          value: node.value,
          params: this._buildParams(node.paramNames || [], paramValues),
        };
      }
      if (node.wildcardChild && node.wildcardChild.value !== null) {
        return {
          value: node.wildcardChild.value,
          params: this._buildParams(node.wildcardChild.paramNames || [], paramValues, ""),
        };
      }
      return null;
    }

    const segment: any = segments[index];
    let decodedSegment: any;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return null;
    }

    const staticChild: any = node.children.get(decodedSegment);
    if (staticChild) {
      const matched: any = this._lookup(staticChild, segments, index + 1, paramValues);
      if (matched) return matched;
    }

    if (node.paramChild) {
      if (Buffer.byteLength(decodedSegment, "utf8") <= ROUTE_PARAMETER_MAX_BYTES) {
        paramValues.push(decodedSegment);
        const matched: any = this._lookup(node.paramChild, segments, index + 1, paramValues);
        paramValues.pop();
        if (matched) return matched;
      }
    }

    if (node.wildcardChild && node.wildcardChild.value !== null) {
      let tail: any;
      try {
        tail = segments.slice(index).map((item?: any) : any => decodeURIComponent(item)).join("/");
      } catch {
        return null;
      }
      if (Buffer.byteLength(tail, "utf8") > ROUTE_WILDCARD_MAX_BYTES) return null;
      return {
        value: node.wildcardChild.value,
        params: this._buildParams(node.wildcardChild.paramNames || [], paramValues, tail),
      };
    }

    return null;
  }

  _buildParams(paramNames?: any, paramValues?: any, wildcardValue: any = null) : any {
    const params: Record<string, any> = {};
    for (let i: any = 0; i < paramValues.length; i++) {
      const key: any = paramNames[i] || `param${i}`;
      params[key] = paramValues[i];
    }
    if (wildcardValue !== null) {
      params["*"] = wildcardValue;
    }
    return params;
  }
}
