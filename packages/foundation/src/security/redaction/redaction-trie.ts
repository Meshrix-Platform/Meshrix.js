/**
 * redaction-trie — Trie-based field-level redaction for audit, trace, and proof records.
 *
 * Supports:
 *  - Exact path matching: "headers.authorization"
 *  - Wildcard path matching: "headers.*.token"
 *  - Schema-annotation-based redaction: fields marked @redact
 *  - SecretRef: replace with reference hash instead of value
 *  - Max string length truncation
 *  - Max array/object entry limits
 *
 * Shared across: audit, trace, risk control, proof, checkpoint, and
 * runtime receipt modules — all use the same redaction policy.
 *
 * @module foundation/security/redaction/redaction-trie
 */

import { canonicalHash } from "../../serialization/canonical-json.ts";

const DEFAULT_MAX_STRING_LENGTH = 256;
const DEFAULT_MAX_ARRAY_ENTRIES = 50;
const DEFAULT_MAX_OBJECT_ENTRIES = 50;
const SECRET_REPLACEMENT_PREFIX = "secretRef:sha256:";

interface RedactionTrieOptions {
  redactPaths?: readonly string[];
  secretPaths?: readonly string[];
  maxStringLength?: number;
  maxArrayEntries?: number;
  maxObjectEntries?: number;
  schemaAnnotatedPaths?: readonly string[];
}

interface RedactedAuditOptions {
  operationId?: string;
  additionalRedactPaths?: readonly string[];
}

interface WildcardPattern {
  pattern: string;
  regex: RegExp;
  isSecret: boolean;
}

export class RedactionTrie {
  _wildcardPatterns: WildcardPattern[];
  maxArrayEntries: number;
  maxObjectEntries: number;
  maxStringLength: number;
  redactPaths: Set<string>;
  schemaAnnotatedPaths: Set<string>;
  secretPaths: Set<string>;
  /**
   * @param {object} [options]
   * @param {string[]} [options.redactPaths] - Exact or wildcard paths to redact
   * @param {string[]} [options.secretPaths] - Paths whose values become secretRef hashes
   * @param {number} [options.maxStringLength=256]
   * @param {number} [options.maxArrayEntries=50]
   * @param {number} [options.maxObjectEntries=50]
   * @param {string[]} [options.schemaAnnotatedPaths] - Paths from schema annotations
   */
  constructor(options: RedactionTrieOptions = {}) {
    this.redactPaths = new Set(options.redactPaths ?? []);
    this.secretPaths = new Set(options.secretPaths ?? []);
    this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    this.maxArrayEntries = options.maxArrayEntries ?? DEFAULT_MAX_ARRAY_ENTRIES;
    this.maxObjectEntries = options.maxObjectEntries ?? DEFAULT_MAX_OBJECT_ENTRIES;
    this.schemaAnnotatedPaths = new Set(options.schemaAnnotatedPaths ?? []);

    // Pre-compiled wildcard patterns
    this._wildcardPatterns = [];
    for (const path of this.redactPaths) {
      if (path.includes("*")) {
        this._wildcardPatterns.push(_compileWildcard(path));
      }
    }
    for (const path of this.secretPaths) {
      if (path.includes("*")) {
        this._wildcardPatterns.push({ ..._compileWildcard(path), isSecret: true });
      }
    }
  }

  /**
   * Redact a value according to the configured policies.
   * @param {*} value - The value to redact
   * @param {string} [pathPrefix=''] - Current JSON path (e.g., "headers.authorization")
   * @param {number} [depth=0] - Current nesting depth
   * @returns {*} Redacted value
   */
  redact(value?: unknown, pathPrefix = "", depth = 0): unknown {
    if (depth > 50) return "[max_depth_exceeded]";

    if (value === null || value === undefined) return value;
    if (typeof value === "boolean" || typeof value === "number") return value;

    // Check if this exact path should be redacted
    if (this._shouldRedact(pathPrefix)) {
      if (this._isSecret(pathPrefix)) {
        return this._secretRef(value);
      }
      return "[redacted]";
    }

    if (typeof value === "string") {
      // Check for inline secrets (common patterns)
      if (this._looksLikeSecret(value) && !this._isSecret(pathPrefix)) {
        return this._secretRef(value);
      }
      if (value.length > this.maxStringLength) {
        return value.slice(0, this.maxStringLength) + `...[truncated ${value.length - this.maxStringLength} chars]`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      const limited = value.slice(0, this.maxArrayEntries);
      return limited.map((item, i) =>
        this.redact(item, `${pathPrefix}[${i}]`, depth + 1)
      );
    }

    if (Buffer.isBuffer(value)) {
      if (this._shouldRedact(pathPrefix)) return "[redacted:buffer]";
      return `[Buffer ${value.length} bytes]`;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value).slice(0, this.maxObjectEntries);
      const result: Record<string, unknown> = {};
      for (const [key, val] of entries) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        result[key] = this.redact(val, childPath, depth + 1);
      }
      return result;
    }

    return value;
  }

  /**
   * Create a redacted audit record from a raw input.
   * @param {object} input - Raw operation input
   * @param {object} [options]
   * @param {string} [options.operationId] - Operation ID for context
   * @param {string[]} [options.additionalRedactPaths] - Extra paths to redact
   * @returns {object} Redacted record with metadata
   */
  createRedactedAuditRecord(input?: unknown, options: RedactedAuditOptions = {}) {
    const extraPaths = options.additionalRedactPaths ?? [];
    const redactedInput = this.redact(input);

    // Re-redact any additional paths not in the base config
    if (extraPaths.length > 0) {
      const tempTrie = new RedactionTrie({
        redactPaths: [...this.redactPaths, ...extraPaths],
        secretPaths: [...this.secretPaths],
        maxStringLength: this.maxStringLength,
      });
      return {
        redactedInput: tempTrie.redact(input),
        inputHash: canonicalHash(input),
        redactedInputHash: canonicalHash(tempTrie.redact(input)),
        redactionPolicyVersion: "v1.0.0",
        operationId: options.operationId || "",
        redactedAt: new Date().toISOString(),
      };
    }

    return {
      redactedInput,
      inputHash: canonicalHash(input),
      redactedInputHash: canonicalHash(redactedInput),
      redactionPolicyVersion: "v1.0.0",
      operationId: options.operationId || "",
      redactedAt: new Date().toISOString(),
    };
  }

  // --- Private ---

  _shouldRedact(path = ""): boolean {
    if (this.redactPaths.has(path)) return true;
    if (this.secretPaths.has(path)) return true;
    if (this.schemaAnnotatedPaths.has(path)) return true;

    for (const pattern of this._wildcardPatterns) {
      if (pattern.regex.test(path)) return true;
    }

    return false;
  }

  _isSecret(path = ""): boolean {
    if (this.secretPaths.has(path)) return true;

    for (const pattern of this._wildcardPatterns) {
      if (pattern.isSecret && pattern.regex.test(path)) return true;
    }

    return false;
  }

  _secretRef(value?: unknown): string {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    const hash = canonicalHash(str);
    return `${SECRET_REPLACEMENT_PREFIX}${hash}`;
  }

  _looksLikeSecret(value?: unknown): boolean {
    const v = String(value || "");
    // Common secret patterns
    if (/^sk-[a-zA-Z0-9]{20,}$/.test(v)) return true; // API keys
    if (/^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/.test(v)) return true; // JWT
    if (/^ghp_[a-zA-Z0-9]{36,}$/.test(v)) return true; // GitHub tokens
    if (/^xox[bprs]-[a-zA-Z0-9-]{10,}$/.test(v)) return true; // Slack tokens
    if (/^pk\.[a-zA-Z0-9]{30,}$/.test(v)) return true; // Stripe publishable keys (sk_ is covered above)
    return false;
  }
}

/**
 * Create a default redaction trie with common secret paths.
 * @returns {RedactionTrie}
 */
export function createDefaultRedactionTrie(): RedactionTrie {
  return new RedactionTrie({
    redactPaths: [
      "password",
      "token",
      "secret",
      "apiKey",
      "api_key",
      "privateKey",
      "private_key",
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "authorization",
      "cookie",
      "set-cookie",
    ],
    secretPaths: [
      "headers.authorization",
      "headers.cookie",
      "headers.set-cookie",
      "headers.x-api-key",
      "headers.x-meshrix-token",
      "query.token",
      "query.code",
      "query.oauth_code",
      "input.password",
      "input.token",
      "input.secret",
      "input.apiKey",
      "input.privateKey",
      "input.oauthCode",
      "input.credential",
      "input.credentials",
      "request.headers.authorization",
      "request.headers.cookie",
      "request.query.token",
      "*.authorization",
      "*.password",
      "*.secret",
      "*.token",
      "*.apiKey",
      "*.private_key",
    ],
    maxStringLength: 256,
    maxArrayEntries: 50,
    maxObjectEntries: 50,
  });
}

// --- Private helpers ---

function _compileWildcard(pattern: string): WildcardPattern {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^.]+")
    .replace(/\[\\\.\+\]/g, "[^.]+");
  return {
    pattern,
    regex: new RegExp(`^${escaped}$`),
    isSecret: false,
  };
}

export { SECRET_REPLACEMENT_PREFIX, DEFAULT_MAX_STRING_LENGTH };
