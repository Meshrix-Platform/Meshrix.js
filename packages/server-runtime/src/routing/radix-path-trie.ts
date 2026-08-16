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

const PATH_SEGMENT = Symbol("path_segment");
const PARAM_SEGMENT = Symbol("param_segment");
const WILDCARD_SEGMENT = Symbol("wildcard_segment");
type SegmentKind = typeof PATH_SEGMENT | typeof PARAM_SEGMENT | typeof WILDCARD_SEGMENT;
const UNRESERVED_CHARACTER_PATTERN = /^[A-Za-z0-9._~-]$/u;
export const ROUTE_PARAMETER_MAX_BYTES = 1_024;
export const ROUTE_WILDCARD_MAX_BYTES = 8_192;

export interface RadixPathMatch<T> {
  value: T;
  params: Record<string, string>;
}

function normalizePercentEncodedUnreserved(segment = ""): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/gu, (_encoded, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_CHARACTER_PATTERN.test(character)
      ? character
      : `%${hex.toUpperCase()}`;
  });
}

export function normalizeRoutingPathname(path?: unknown): string | null {
  let pathname = String(path || "/").trim().split("?", 1)[0].split("#", 1)[0];
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  const segments = pathname.split("/").filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if ([...decoded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })) return null;
    normalized.push(normalizePercentEncodedUnreserved(segment));
  }
  return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
}

class RadixTrieNode<T> {
  children: Map<string, RadixTrieNode<T>>;
  kind: SegmentKind;
  paramChild: RadixTrieNode<T> | null;
  paramName: string | null;
  paramNames: string[];
  segment: string;
  value: T | null;
  wildcardChild: RadixTrieNode<T> | null;
  constructor(segment = "", kind: SegmentKind = PATH_SEGMENT) {
    this.segment = segment;
    this.kind = kind;
    this.children = new Map();
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

export class RadixPathTrie<T = unknown> {
  _paths: Set<string>;
  _size: number;
  root: RadixTrieNode<T>;
  constructor() {
    this.root = new RadixTrieNode("/", PATH_SEGMENT);
    this._size = 0;
    this._paths = new Set();
  }

  get size(): number {
    return this._size;
  }

  /**
   * Insert a path with associated value.
   * @param {string} path - The URL path pattern (e.g., "/api/workspace/:id")
   * @param {*} value - The value to store at this path
   * @returns {boolean} true if inserted, false if duplicate
   * @throws {Error} if path conflicts with existing route
   */
  insert(path: string, value: T): boolean {
    const normalized = normalizeRoutingPathname(path);
    if (normalized === null) {
      throw new Error("Route path contains invalid encoding or control characters.");
    }
    if (this._paths.has(normalized)) {
      return false;
    }

    const segments = this._parseSegments(normalized);
    this._validateSegments(segments, normalized);

    let node = this.root;
    const paramNames: string[] = [];
    for (const segment of segments) {
      const kind = this._segmentKind(segment);
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
        node = node.children.get(segment)!;
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
  lookup(path?: unknown): RadixPathMatch<T> | null {
    const normalized = normalizeRoutingPathname(path);
    if (normalized === null) return null;
    const segments = normalized.split("/").filter(Boolean);
    return this._lookup(this.root, segments, 0, []);
  }

  /**
   * Detect conflicts: returns array of { path, conflictPath, reason }.
   */
  detectConflicts(): Array<{ path: string; conflictPath: string; reason: string }> {
    // Duplicate concrete patterns and equivalent parameter shapes are rejected
    // during insertion. Static, parameter, and wildcard siblings are valid and
    // are resolved deterministically in that order.
    return [];
  }

  /**
   * Return all stored path patterns.
   */
  paths(): string[] {
    return [...this._paths];
  }

  // --- private ---

  _parseSegments(normalizedPath: string): string[] {
    if (normalizedPath === "/") return [];
    return normalizedPath.split("/").filter(Boolean);
  }

  _segmentKind(segment: string): SegmentKind {
    if (segment === "*" || segment === "**") return WILDCARD_SEGMENT;
    if (segment.startsWith(":")) return PARAM_SEGMENT;
    return PATH_SEGMENT;
  }

  _validateSegments(segments: string[], fullPath: string): void {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const kind = this._segmentKind(segment);
      if (kind === WILDCARD_SEGMENT) {
        if (i !== segments.length - 1) {
          throw new Error(`Wildcard must be the final segment in path: "${fullPath}"`);
        }
        continue;
      }
      if (kind === PARAM_SEGMENT) {
        const paramName = segment.startsWith(":") ? segment.slice(1) : segment;
        if (!paramName) {
          throw new Error(`Parameter name is required in path: "${fullPath}"`);
        }
      }
    }
  }

  _lookup(node: RadixTrieNode<T>, segments: string[], index: number, paramValues: string[]): RadixPathMatch<T> | null {
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

    const segment = segments[index];
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      return null;
    }

    const staticChild = node.children.get(decodedSegment);
    if (staticChild) {
      const matched = this._lookup(staticChild, segments, index + 1, paramValues);
      if (matched) return matched;
    }

    if (node.paramChild) {
      if (Buffer.byteLength(decodedSegment, "utf8") <= ROUTE_PARAMETER_MAX_BYTES) {
        paramValues.push(decodedSegment);
        const matched = this._lookup(node.paramChild, segments, index + 1, paramValues);
        paramValues.pop();
        if (matched) return matched;
      }
    }

    if (node.wildcardChild && node.wildcardChild.value !== null) {
      let tail: string;
      try {
        tail = segments.slice(index).map((item) => decodeURIComponent(item)).join("/");
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

  _buildParams(paramNames: string[], paramValues: string[], wildcardValue: string | null = null): Record<string, string> {
    const params: Record<string, string> = {};
    for (let i = 0; i < paramValues.length; i++) {
      const key = paramNames[i] || `param${i}`;
      params[key] = paramValues[i];
    }
    if (wildcardValue !== null) {
      params["*"] = wildcardValue;
    }
    return params;
  }
}
