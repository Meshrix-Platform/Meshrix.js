import { DurableObject } from "cloudflare:workers";

import { normalizeUpstreamMcpHttpRequestHeaders } from "../../../packages/contracts/src/upstream-service-publishing.ts";
import {
  GatewaySchemaError,
  type CompiledExternalSchema,
} from "../../../packages/kernel/src/schema/budget.ts";
import { compileInterpretedSchema } from "../../../packages/kernel/src/schema/interpreted.ts";
import { canonicalJson } from "../../../packages/kernel/src/utils.ts";
import {
  buildApprovalRequest,
  evaluateConclusion,
  isPairId,
  parsePairCode,
  pubkeyFingerprint,
  requestDigest,
  validateApproverPubkey,
  validateRelayBaseUrl,
} from "./entio.ts";
import { safeUpstreamFetch, UpstreamUrlError, validateUpstreamUrl } from "./ssrf.ts";

export interface GatewayEnv {
  readonly GATEWAY: DurableObjectNamespace<MeshrixGatewayDO>;
  readonly DEMO_MODE?: string;
  readonly ADMIN_TOKEN?: string;
  readonly ADMIN_DECIDE_ENABLED?: string;
  readonly ENTIO_INSTANCE?: string;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_DEMO_ACTIVE_KEYS = 50;
const DEMO_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const DEMO_MAX_AUDIT_EVENTS = 200;
const SELF_HOSTED_MAX_AUDIT_EVENTS = 2_000;
const APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_APPROVALS = 200;
const KEY_LAST_USED_DEBOUNCE_MS = 60_000;
const MAX_SCHEMA_CACHE_ENTRIES = 64;
const MAX_ENTIO_PAIRINGS = 8;
const MAX_STORED_ENTIO_REQUESTS = 200;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const ENTIO_LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const SENSITIVE_KEY_PATTERN = /(?:secret|token|password|api[-_]?key|auth|credential)/iu;
const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const UPSTREAM_VISIBLE_TOKEN_PATTERN = /^[\x21-\x7e]{1,256}$/u;
const UPSTREAM_SESSION_HINT_PATTERN = /session|initializ/iu;
const MAX_UPSTREAM_SESSION_ENTRIES = 128;
const GATEWAY_UPSTREAM_CLIENT_INFO = Object.freeze({
  name: "meshrix-cloudflare-gateway",
  version: "0.4.2",
});

const textEncoder = new TextEncoder();

interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly token_hash: string;
  readonly allowed_tools_json: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly last_used_at: number | null;
  readonly is_demo: number;
}

interface ToolRow {
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly upstream_url: string | null;
  readonly upstream_tool_name: string | null;
  readonly upstream_headers_json: string | null;
  readonly input_schema_json: string;
  readonly requires_approval: number;
  readonly idempotent_call: number;
  readonly created_at: number;
}

interface ApprovalRow {
  readonly id: string;
  readonly key_id: string;
  readonly key_name: string;
  readonly tool_name: string;
  readonly args_sha256: string;
  readonly args_preview: string;
  readonly status: string;
  readonly decision_reason: string | null;
  readonly created_at: number;
  readonly expires_at: number;
  readonly decided_at: number | null;
  readonly consumed_at: number | null;
}

interface EntioPairingRow {
  readonly label: string;
  readonly relay: string;
  readonly pair: string;
  readonly secret: string;
  readonly pubkey: string;
  readonly fingerprint: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface EntioRequestRow {
  readonly id: string;
  readonly approval_id: string;
  readonly pairing_label: string;
  readonly relay_rid: string | null;
  readonly request_json: string;
  readonly request_digest: string;
  readonly status: string;
  readonly detail: string | null;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly decided_at: number | null;
  readonly decision: string | null;
  readonly created_at: number;
}

interface AuditEventRow {
  readonly id: number;
  readonly event_id: string;
  readonly ts: number;
  readonly event_type: string;
  readonly key_id: string | null;
  readonly tool_name: string | null;
  readonly args_sha256: string | null;
  readonly decision: string;
  readonly detail_code: string;
  readonly approval_id: string | null;
  readonly latency_ms: number | null;
}

interface SeedToolDef {
  readonly name: string;
  readonly description: string;
  readonly requiresApproval: boolean;
  readonly inputSchema: Record<string, unknown>;
}

const DEMO_SEED_TOOLS: readonly SeedToolDef[] = Object.freeze([
  {
    name: "demo.echo",
    description: "Echo a message through the governed MCP gateway with schema validation and audit receipts.",
    requiresApproval: false,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 500 },
        tag: { type: "string", maxLength: 64 },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "demo.format_note",
    description: "Format a structured Markdown note after JSON Schema 2020-12 validation.",
    requiresApproval: false,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        body: { type: "string", minLength: 1, maxLength: 2000 },
        tags: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 32 },
          maxItems: 10,
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "demo.sensitive_deploy",
    description: "Simulate a privileged deployment requiring single-use human approval bound to key, tool, and arguments.",
    requiresApproval: true,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        service: { type: "string", minLength: 1, maxLength: 80 },
        environment: { type: "string", enum: ["staging", "production"] },
        version: { type: "string", pattern: "^[A-Za-z0-9._-]{1,40}$" },
        dryRun: { type: "boolean" },
      },
      required: ["service", "environment", "version"],
      additionalProperties: false,
    },
  },
]);

/** Fixed-length XOR accumulator over equal-length digest bytes. */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBase64Url(12)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactArgsPreview(args: Record<string, unknown>): string {
  const sanitize = (value: unknown, depth: number): unknown => {
    if (depth > 4) return "[...]";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item, depth + 1));
    if (isPlainRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value).slice(0, 16)) {
        out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[REDACTED]" : sanitize(v, depth + 1);
      }
      return out;
    }
    if (typeof value === "string" && value.length > 120) {
      return `${value.slice(0, 117)}...`;
    }
    return value;
  };
  const encoded = JSON.stringify(sanitize(args, 0));
  return encoded.length > 300 ? `${encoded.slice(0, 297)}...` : encoded;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function jsonError(
  status: number,
  error: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  extraFields: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { error, message, ...extraFields }, extraHeaders);
}

function mcpResult(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse(200, { jsonrpc: "2.0", id: id ?? null, result }, extraHeaders);
}

function mcpError(
  status: number,
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: data ? { code, message, data } : { code, message },
    },
    extraHeaders,
  );
}

function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(headerValue.trim());
  return match ? match[1]! : null;
}

async function readBoundedText(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string; message: string }> {
  const declaredLen = request.headers.get("content-length");
  if (declaredLen !== null) {
    const numeric = Number(declaredLen);
    if (Number.isFinite(numeric) && numeric > maxBytes) {
      return { ok: false, status: 413, error: "payload_too_large", message: "Request body exceeds maximum allowed size." };
    }
  }
  const text = await request.text();
  if (textEncoder.encode(text).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "payload_too_large", message: "Request body exceeds maximum allowed size." };
  }
  return { ok: true, text };
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLen = response.headers.get("content-length");
  if (declaredLen !== null) {
    const numeric = Number(declaredLen);
    if (Number.isFinite(numeric) && numeric > maxBytes) {
      throw new Error("Upstream response exceeds maximum allowed byte budget.");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Response exceeded byte budget").catch(() => undefined);
        throw new Error("Upstream response exceeds maximum allowed byte budget.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

interface UpstreamSession {
  readonly sessionId: string | null;
  readonly protocolVersion: string;
}

interface ScopedUpstreamSession {
  readonly keyId: string;
  readonly toolName: string;
  readonly mode: "stateful" | "stateless";
  readonly session: UpstreamSession | null;
}

type UpstreamCallFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly upstreamCode?: number;
  readonly sessionExpired?: boolean;
  readonly evictCachedSession?: boolean;
  readonly notSent?: boolean;
  readonly resultUnknown?: boolean;
};

type UpstreamCallOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown>; readonly returnedSessionId: string | null }
  | UpstreamCallFailure;

type UpstreamHandshakeOutcome =
  | { readonly ok: true; readonly mode: "stateful"; readonly session: UpstreamSession }
  | { readonly ok: true; readonly mode: "stateless"; readonly session: null }
  | UpstreamCallFailure;

function readUpstreamSessionId(response: Response): string | null {
  const raw = response.headers.get("mcp-session-id");
  if (!raw || !UPSTREAM_VISIBLE_TOKEN_PATTERN.test(raw)) return null;
  return raw;
}

function matchesExpectedJsonRpcFrame(
  parsed: Record<string, unknown>,
  expectedId: string | number | null,
): boolean {
  if (!("result" in parsed) && !("error" in parsed)) return false;
  if (expectedId === null) return true;
  if (parsed.id === expectedId) return true;
  return isPlainRecord(parsed.error) && (parsed.id === null || parsed.id === undefined);
}

function parseSseEventData(dataLines: readonly string[]): Record<string, unknown> | null {
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readUpstreamJsonRpcMessage(
  response: Response,
  expectedId: string | number | null,
  maxBytes: number,
): Promise<{ ok: true; parsed: Record<string, unknown> | null } | { ok: false; tooLarge: true }> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    try {
      const rawText = await readBoundedResponseText(response, maxBytes);
      if (!rawText.trim()) return { ok: true, parsed: null };
      const parsed = JSON.parse(rawText);
      return { ok: true, parsed: isPlainRecord(parsed) ? parsed : null };
    } catch (error) {
      if (error instanceof Error && error.message.includes("byte budget")) {
        return { ok: false, tooLarge: true };
      }
      return { ok: true, parsed: null };
    }
  }

  const declaredLen = response.headers.get("content-length");
  if (declaredLen !== null) {
    const numeric = Number(declaredLen);
    if (Number.isFinite(numeric) && numeric > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
  }
  if (!response.body) return { ok: true, parsed: null };

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let lineBuffer = "";
  let pendingCr = false;
  let dataLines: string[] = [];
  let fallbackParsed: Record<string, unknown> | null = null;

  const consumeEvent = (): Record<string, unknown> | null => {
    const parsed = parseSseEventData(dataLines);
    dataLines = [];
    if (!parsed) return null;
    fallbackParsed = parsed;
    return matchesExpectedJsonRpcFrame(parsed, expectedId) ? parsed : null;
  };

  const processLine = (line: string): Record<string, unknown> | null => {
    if (line === "") {
      return consumeEvent();
    }
    if (line.startsWith(":")) return null;
    if (line.startsWith("data:")) {
      const after = line.slice(5);
      dataLines.push(after.startsWith(" ") ? after.slice(1) : after);
    }
    return null;
  };

  const feedText = (chunkText: string): Record<string, unknown> | null => {
    for (let i = 0; i < chunkText.length; i += 1) {
      const ch = chunkText[i]!;
      if (pendingCr) {
        pendingCr = false;
        if (ch === "\n") continue;
      }
      if (ch === "\r" || ch === "\n") {
        const currentLine = lineBuffer;
        lineBuffer = "";
        if (ch === "\r") pendingCr = true;
        const matched = processLine(currentLine);
        if (matched) return matched;
      } else {
        lineBuffer += ch;
      }
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Response exceeded byte budget").catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      const matched = feedText(decoder.decode(value, { stream: true }));
      if (matched) {
        await reader.cancel().catch(() => undefined);
        return { ok: true, parsed: matched };
      }
    }
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      const matched = feedText(trailing);
      if (matched) return { ok: true, parsed: matched };
    }
    if (lineBuffer.length > 0) {
      const matched = processLine(lineBuffer);
      lineBuffer = "";
      if (matched) return { ok: true, parsed: matched };
    }
    const tailMatched = consumeEvent();
    return { ok: true, parsed: tailMatched ?? fallbackParsed };
  } finally {
    reader.releaseLock();
  }
}

export class MeshrixGatewayDO extends DurableObject<GatewayEnv> {
  readonly #sql: SqlStorage;
  readonly #schemaCache = new Map<string, { readonly rawJson: string; readonly compiled: CompiledExternalSchema }>();
  readonly #upstreamSessions = new Map<string, ScopedUpstreamSession>();
  readonly #upstreamHandshakes = new Map<string, { readonly keyId: string; readonly toolName: string; readonly promise: Promise<UpstreamHandshakeOutcome> }>();
  #auditEventCount = 0;
  #initialized = false;

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#ensureInitialized();
  }

  #isDemoMode(): boolean {
    return String(this.env.DEMO_MODE ?? "false").toLowerCase() === "true";
  }

  #ensureInitialized(): void {
    if (this.#initialized) return;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        allowed_tools_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        last_used_at INTEGER,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_demo_created ON api_keys(is_demo, revoked_at, created_at);

      CREATE TABLE IF NOT EXISTS tools (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        upstream_url TEXT,
        upstream_tool_name TEXT,
        upstream_headers_json TEXT,
        input_schema_json TEXT NOT NULL,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        idempotent_call INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL,
        key_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_sha256 TEXT NOT NULL,
        args_preview TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_reason TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_lookup ON approvals(key_id, tool_name, args_sha256, status);
      CREATE INDEX IF NOT EXISTS idx_approvals_created ON approvals(created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        key_id TEXT,
        tool_name TEXT,
        args_sha256 TEXT,
        decision TEXT NOT NULL,
        detail_code TEXT NOT NULL,
        approval_id TEXT,
        latency_ms INTEGER
      );
      DROP INDEX IF EXISTS idx_audit_events_ts;

      CREATE TABLE IF NOT EXISTS entio_pairings (
        label TEXT PRIMARY KEY,
        relay TEXT NOT NULL,
        pair TEXT NOT NULL,
        secret TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entio_requests (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        pairing_label TEXT NOT NULL,
        relay_rid TEXT,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decision TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entio_requests_approval ON entio_requests(approval_id, status);
      CREATE INDEX IF NOT EXISTS idx_entio_requests_created ON entio_requests(created_at DESC);
    `);

    // Deployments created before declarative upstream headers lack the column.
    const toolColumns = new Set(
      this.#allRows<{ readonly name: string }>("PRAGMA table_info(tools)").map((r) => r.name),
    );
    if (!toolColumns.has("upstream_headers_json")) {
      this.#sql.exec("ALTER TABLE tools ADD COLUMN upstream_headers_json TEXT");
    }
    if (!toolColumns.has("idempotent_call")) {
      this.#sql.exec("ALTER TABLE tools ADD COLUMN idempotent_call INTEGER NOT NULL DEFAULT 0");
    }

    if (this.#isDemoMode()) {
      const now = Date.now();
      for (const seed of DEMO_SEED_TOOLS) {
        this.#sql.exec(
          `INSERT OR IGNORE INTO tools (name, description, kind, upstream_url, upstream_tool_name, input_schema_json, requires_approval, created_at)
           VALUES (?, ?, 'builtin', NULL, NULL, ?, ?, ?)`,
          seed.name,
          seed.description,
          JSON.stringify(seed.inputSchema),
          seed.requiresApproval ? 1 : 0,
          now,
        );
      }
    }
    const initialCount = Number(
      this.#firstRow<{ readonly cnt: number }>("SELECT COUNT(*) AS cnt FROM audit_events")?.cnt ?? 0,
    );
    const maxAudit = this.#isDemoMode() ? DEMO_MAX_AUDIT_EVENTS : SELF_HOSTED_MAX_AUDIT_EVENTS;
    if (initialCount > maxAudit) {
      const removed = this.#sql
        .exec(
          `DELETE FROM audit_events
           WHERE id IN (SELECT id FROM audit_events ORDER BY id ASC LIMIT ?)
           RETURNING id`,
          initialCount - maxAudit,
        )
        .toArray().length;
      this.#auditEventCount = initialCount - removed;
    } else {
      this.#auditEventCount = initialCount;
    }
    this.#initialized = true;
  }

  #runAtomic<T>(fn: () => T): T {
    const storage = this.ctx.storage as { transactionSync?: <R>(cb: () => R) => R };
    return typeof storage.transactionSync === "function" ? storage.transactionSync(fn) : fn();
  }

  #firstRow<T>(query: string, ...bindings: unknown[]): T | null {
    const rows = this.#sql.exec(query, ...bindings).toArray();
    return rows.length > 0 ? (rows[0] as unknown as T) : null;
  }

  #allRows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.#sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  #getCompiledSchema(tool: ToolRow): CompiledExternalSchema {
    const cached = this.#schemaCache.get(tool.name);
    if (cached && cached.rawJson === tool.input_schema_json) {
      this.#schemaCache.delete(tool.name);
      this.#schemaCache.set(tool.name, cached);
      return cached.compiled;
    }
    const parsed = JSON.parse(tool.input_schema_json) as unknown;
    const compiled = compileInterpretedSchema(parsed, { label: tool.name });
    if (this.#schemaCache.size >= MAX_SCHEMA_CACHE_ENTRIES) {
      const oldest = this.#schemaCache.keys().next().value;
      if (oldest !== undefined) this.#schemaCache.delete(oldest);
    }
    this.#schemaCache.set(tool.name, { rawJson: tool.input_schema_json, compiled });
    return compiled;
  }

  #recordAudit(entry: {
    readonly eventType: string;
    readonly keyId?: string | null;
    readonly toolName?: string | null;
    readonly argsSha256?: string | null;
    readonly decision: string;
    readonly detailCode: string;
    readonly approvalId?: string | null;
    readonly latencyMs?: number | null;
  }): void {
    const now = Date.now();
    const maxAudit = this.#isDemoMode() ? DEMO_MAX_AUDIT_EVENTS : SELF_HOSTED_MAX_AUDIT_EVENTS;
    let nextCount = this.#auditEventCount;
    this.#runAtomic(() => {
      this.#sql.exec(
        `INSERT INTO audit_events (event_id, ts, event_type, key_id, tool_name, args_sha256, decision, detail_code, approval_id, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomId("evt"),
        now,
        entry.eventType,
        entry.keyId ?? null,
        entry.toolName ?? null,
        entry.argsSha256 ?? null,
        entry.decision,
        entry.detailCode,
        entry.approvalId ?? null,
        entry.latencyMs ?? null,
      );
      nextCount = this.#auditEventCount + 1;
      if (nextCount > maxAudit) {
        const deleted = this.#sql
          .exec(
            `DELETE FROM audit_events
             WHERE id IN (SELECT id FROM audit_events ORDER BY id ASC LIMIT ?)
             RETURNING id`,
            nextCount - maxAudit,
          )
          .toArray().length;
        nextCount -= deleted;
      }
    });
    this.#auditEventCount = nextCount;
  }

  #pruneApprovals(): void {
    this.#sql.exec(
      `DELETE FROM approvals
       WHERE id NOT IN (SELECT id FROM approvals ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      MAX_STORED_APPROVALS,
    );
  }

  async #authorizeAdmin(request: Request): Promise<Response | null> {
    if (this.#isDemoMode()) return null;

    const configuredToken = typeof this.env.ADMIN_TOKEN === "string" ? this.env.ADMIN_TOKEN.trim() : "";
    if (!configuredToken) {
      return jsonError(
        503,
        "admin_token_unconfigured",
        "ADMIN_TOKEN is not configured. Set it via `wrangler secret put ADMIN_TOKEN`.",
      );
    }

    const presented = extractBearerToken(request.headers.get("authorization"));
    if (!presented) {
      return jsonError(401, "unauthorized", "Bearer ADMIN_TOKEN is required.", {
        "WWW-Authenticate": "Bearer",
      });
    }

    const [expectedDigest, providedDigest] = await Promise.all([
      sha256Bytes(configuredToken),
      sha256Bytes(presented),
    ]);
    if (!constantTimeEqualBytes(expectedDigest, providedDigest)) {
      return jsonError(401, "unauthorized", "Invalid ADMIN_TOKEN.", {
        "WWW-Authenticate": "Bearer",
      });
    }

    return null;
  }

  async #authenticateApiKey(request: Request): Promise<
    | { readonly ok: true; readonly key: ApiKeyRow; readonly allowedTools: readonly string[] }
    | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }
  > {
    const authHeader = request.headers.get("authorization");
    let rawToken: string | null = null;
    if (authHeader !== null) {
      rawToken = extractBearerToken(authHeader);
      if (!rawToken) {
        return { ok: false, status: 401, code: "unauthorized", message: "Authorization header must use Bearer scheme." };
      }
    } else {
      const alt = request.headers.get("x-meshrix.js-api-key")?.trim();
      if (alt) rawToken = alt;
    }

    if (!rawToken) {
      return { ok: false, status: 401, code: "unauthorized", message: "Bearer API key is required." };
    }

    const presentedDigest = await sha256Bytes(rawToken);
    const presentedHex = bytesToHex(presentedDigest);
    const row = this.#firstRow<ApiKeyRow>(
      "SELECT * FROM api_keys WHERE token_hash = ? LIMIT 1",
      presentedHex,
    );
    if (!row) {
      return { ok: false, status: 401, code: "unauthorized", message: "API key is invalid." };
    }

    const storedDigest = hexToBytes(row.token_hash);
    if (!storedDigest || !constantTimeEqualBytes(presentedDigest, storedDigest)) {
      return { ok: false, status: 401, code: "unauthorized", message: "API key is invalid." };
    }

    const now = Date.now();
    if (row.revoked_at !== null) {
      return { ok: false, status: 401, code: "api_key_revoked", message: "API key has been revoked." };
    }
    if (row.expires_at !== null && row.expires_at <= now) {
      return { ok: false, status: 401, code: "api_key_expired", message: "API key has expired." };
    }

    let allowedTools: string[] = [];
    try {
      const parsed = JSON.parse(row.allowed_tools_json);
      if (Array.isArray(parsed)) {
        allowedTools = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      allowedTools = [];
    }

    return { ok: true, key: row, allowedTools };
  }

  /** Parse stored declarative request headers for upstream forwarding. */
  #upstreamHeaders(row: ToolRow): Record<string, string> {
    if (!row.upstream_headers_json) return {};
    try {
      const parsed: unknown = JSON.parse(row.upstream_headers_json);
      if (!isPlainRecord(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[name] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Header names are safe to expose in admin state; values never leave the DO. */
  #upstreamHeaderNames(row: ToolRow): string[] {
    return Object.keys(this.#upstreamHeaders(row)).sort();
  }

  #serializeTool(row: ToolRow) {
    return {
      name: row.name,
      description: row.description,
      kind: row.kind,
      upstreamUrl: row.upstream_url,
      upstreamToolName: row.upstream_tool_name,
      upstreamHeaderNames: this.#upstreamHeaderNames(row),
      inputSchema: JSON.parse(row.input_schema_json) as unknown,
      requiresApproval: row.requires_approval === 1,
      idempotent: row.idempotent_call === 1,
      createdAt: row.created_at,
    };
  }

  #serializeKey(row: ApiKeyRow, now: number) {
    let status: "active" | "revoked" | "expired" = "active";
    if (row.revoked_at !== null) status = "revoked";
    else if (row.expires_at !== null && row.expires_at <= now) status = "expired";

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      allowedTools: JSON.parse(row.allowed_tools_json) as string[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      isDemo: row.is_demo === 1,
      status,
    };
  }

  #serializeApproval(row: ApprovalRow, now: number) {
    let effectiveStatus = row.status;
    if ((effectiveStatus === "pending" || effectiveStatus === "approved") && row.expires_at <= now) {
      effectiveStatus = "expired";
    }
    return {
      id: row.id,
      keyId: row.key_id,
      keyName: row.key_name,
      toolName: row.tool_name,
      argsSha256: row.args_sha256,
      argsPreview: row.args_preview,
      status: effectiveStatus,
      decisionReason: row.decision_reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      consumedAt: row.consumed_at,
    };
  }

  #serializePairing(row: EntioPairingRow) {
    return {
      label: row.label,
      relay: row.relay,
      pair: row.pair,
      pubkey: row.pubkey,
      fingerprint: row.fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #serializeEntioRequest(row: EntioRequestRow) {
    return {
      id: row.id,
      approvalId: row.approval_id,
      pairing: row.pairing_label,
      relayRid: row.relay_rid,
      requestDigest: row.request_digest,
      status: row.status,
      detail: row.detail,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decision: row.decision,
      createdAt: row.created_at,
    };
  }

  #serializeAudit(row: AuditEventRow) {
    return {
      id: row.event_id,
      ts: row.ts,
      eventType: row.event_type,
      keyId: row.key_id,
      toolName: row.tool_name,
      argsSha256: row.args_sha256,
      decision: row.decision,
      detailCode: row.detail_code,
      approvalId: row.approval_id,
      latencyMs: row.latency_ms,
    };
  }

  async #handleAdminState(request: Request): Promise<Response> {
    const now = Date.now();
    const demoMode = this.#isDemoMode();
    let demoCallerKeyId: string | null = null;
    if (demoMode && extractBearerToken(request.headers.get("authorization"))) {
      const callerAuth = await this.#authenticateApiKey(request);
      if (callerAuth.ok) demoCallerKeyId = callerAuth.key.id;
    }

    const tools = this.#allRows<ToolRow>("SELECT * FROM tools ORDER BY name ASC").map((r) => this.#serializeTool(r));
    const keys = demoMode
      ? demoCallerKeyId
        ? this.#allRows<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ? LIMIT 1", demoCallerKeyId).map((r) =>
            this.#serializeKey(r, now),
          )
        : []
      : this.#allRows<ApiKeyRow>("SELECT * FROM api_keys ORDER BY created_at DESC LIMIT 100").map((r) =>
          this.#serializeKey(r, now),
        );
    const approvals = demoMode
      ? demoCallerKeyId
        ? this.#allRows<ApprovalRow>(
            "SELECT * FROM approvals WHERE key_id = ? ORDER BY created_at DESC LIMIT 50",
            demoCallerKeyId,
          ).map((r) => this.#serializeApproval(r, now))
        : []
      : this.#allRows<ApprovalRow>("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50").map((r) =>
          this.#serializeApproval(r, now),
        );
    const entioPairings = demoMode
      ? []
      : this.#allRows<EntioPairingRow>("SELECT * FROM entio_pairings ORDER BY label ASC").map((r) =>
          this.#serializePairing(r),
        );
    const entioRequests = demoMode
      ? []
      : this.#allRows<EntioRequestRow>(
          "SELECT * FROM entio_requests ORDER BY created_at DESC LIMIT 50",
        ).map((r) => this.#serializeEntioRequest(r));
    const auditEvents = demoMode
      ? demoCallerKeyId
        ? this.#allRows<AuditEventRow>(
            "SELECT * FROM audit_events WHERE key_id = ? ORDER BY id DESC LIMIT 100",
            demoCallerKeyId,
          ).map((r) => this.#serializeAudit(r))
        : []
      : this.#allRows<AuditEventRow>("SELECT * FROM audit_events ORDER BY id DESC LIMIT 100").map((r) =>
          this.#serializeAudit(r),
        );

    return jsonResponse(200, {
      mode: demoMode ? "demo" : "self-hosted",
      demoMode,
      limits: {
        maxDemoKeys: MAX_DEMO_ACTIVE_KEYS,
        demoKeyTtlHours: DEMO_KEY_TTL_MS / 3_600_000,
        maxAuditEvents: demoMode ? DEMO_MAX_AUDIT_EVENTS : SELF_HOSTED_MAX_AUDIT_EVENTS,
      },
      tools,
      keys,
      approvals,
      entio: {
        enabled: !demoMode,
        pairings: entioPairings,
        requests: entioRequests,
      },
      auditEvents,
    });
  }

  async #handleMintKey(request: Request): Promise<Response> {
    const bodyResult = await readBoundedText(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) return jsonError(bodyResult.status, bodyResult.error, bodyResult.message);

    let body: Record<string, unknown> = {};
    if (bodyResult.text.trim()) {
      try {
        const parsed = JSON.parse(bodyResult.text);
        if (!isPlainRecord(parsed)) return jsonError(400, "invalid_request", "Request body must be a JSON object.");
        body = parsed;
      } catch {
        return jsonError(400, "invalid_json", "Request body is not valid JSON.");
      }
    }

    const demoMode = this.#isDemoMode();
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const name = (rawName || (demoMode ? "demo-client" : "client-key")).slice(0, 80);
    if (/[\u0000-\u001f\u007f]/u.test(name)) {
      return jsonError(400, "invalid_key_name", "Key name contains control characters.");
    }

    const registeredTools = new Set(
      this.#allRows<{ readonly name: string }>("SELECT name FROM tools").map((r) => r.name),
    );

    if (!Array.isArray(body.allowedTools) || body.allowedTools.length === 0) {
      return jsonError(400, "invalid_allowed_tools", "allowedTools must be a non-empty array of tool names.");
    }
    const allowedTools: string[] = [];
    for (const entry of body.allowedTools) {
      if (typeof entry !== "string" || !registeredTools.has(entry)) {
        return jsonError(400, "invalid_allowed_tools", `Unknown tool in allowedTools: ${String(entry)}`);
      }
      if (!allowedTools.includes(entry)) allowedTools.push(entry);
    }

    const now = Date.now();
    let expiresAt: number | null = null;
    if (demoMode) {
      let ttlMs = DEMO_KEY_TTL_MS;
      if (body.ttlSeconds !== undefined) {
        if (typeof body.ttlSeconds !== "number" || !Number.isFinite(body.ttlSeconds) || body.ttlSeconds <= 0) {
          return jsonError(400, "invalid_ttl", "ttlSeconds must be a positive number.");
        }
        ttlMs = Math.min(DEMO_KEY_TTL_MS, Math.floor(body.ttlSeconds * 1000));
      }
      expiresAt = now + ttlMs;

      // Clean expired demo keys and enforce active demo key cap (evict oldest)
      this.#sql.exec(
        "DELETE FROM api_keys WHERE is_demo = 1 AND ((expires_at IS NOT NULL AND expires_at <= ?) OR revoked_at IS NOT NULL)",
        now,
      );
      const activeDemoRows = this.#allRows<{ readonly id: string }>(
        "SELECT id FROM api_keys WHERE is_demo = 1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC, rowid ASC",
        now,
      );
      const excess = activeDemoRows.length - (MAX_DEMO_ACTIVE_KEYS - 1);
      if (excess > 0) {
        for (const victim of activeDemoRows.slice(0, excess)) {
          this.#sql.exec("DELETE FROM api_keys WHERE id = ?", victim.id);
        }
      }
    } else if (body.ttlSeconds !== undefined && body.ttlSeconds !== null) {
      if (typeof body.ttlSeconds !== "number" || !Number.isFinite(body.ttlSeconds) || body.ttlSeconds <= 0) {
        return jsonError(400, "invalid_ttl", "ttlSeconds must be a positive number.");
      }
      expiresAt = now + Math.floor(body.ttlSeconds * 1000);
    }

    const keyId = randomId("key");
    const rawToken = `mx_${demoMode ? "demo" : "live"}_${randomBase64Url(24)}`;
    const prefix = `${rawToken.slice(0, 14)}...`;
    const tokenHash = await sha256Hex(rawToken);

    this.#sql.exec(
      `INSERT INTO api_keys (id, name, prefix, token_hash, allowed_tools_json, created_at, expires_at, revoked_at, last_used_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      keyId,
      name,
      prefix,
      tokenHash,
      JSON.stringify(allowedTools),
      now,
      expiresAt,
      demoMode ? 1 : 0,
    );

    this.#recordAudit({
      eventType: "key.minted",
      keyId,
      decision: "allowed",
      detailCode: "ok",
    });

    return jsonResponse(201, {
      key: {
        id: keyId,
        name,
        prefix,
        allowedTools,
        createdAt: now,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        isDemo: demoMode,
        status: "active",
      },
      token: rawToken,
    });
  }

  async #handleRevokeKey(request: Request, keyId: string): Promise<Response> {
    if (this.#isDemoMode()) {
      const callerAuth = await this.#authenticateApiKey(request);
      if (!callerAuth.ok || callerAuth.key.id !== keyId) {
        return jsonError(401, "unauthorized", "Present the matching demo API key Bearer token to revoke it.");
      }
    }
    const now = Date.now();
    const res = this.#sql.exec(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id",
      now,
      keyId,
    );
    if (res.toArray().length === 0) {
      const existing = this.#firstRow<{ readonly id: string }>("SELECT id FROM api_keys WHERE id = ?", keyId);
      if (!existing) return jsonError(404, "key_not_found", "API key not found.");
      return jsonResponse(200, { ok: true, id: keyId, alreadyRevoked: true });
    }
    this.#invalidateUpstreamSessions({ keyId });
    this.#recordAudit({
      eventType: "key.revoked",
      keyId,
      decision: "allowed",
      detailCode: "ok",
    });
    return jsonResponse(200, { ok: true, id: keyId, revokedAt: now });
  }

  async #handleRegisterTool(request: Request): Promise<Response> {
    if (this.#isDemoMode()) {
      return jsonError(
        403,
        "demo_mode_upstream_disabled",
        "Custom upstream registration is disabled in public demo mode.",
      );
    }

    const bodyResult = await readBoundedText(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) return jsonError(bodyResult.status, bodyResult.error, bodyResult.message);

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyResult.text);
      if (!isPlainRecord(parsed)) return jsonError(400, "invalid_request", "Request body must be a JSON object.");
      body = parsed;
    } catch {
      return jsonError(400, "invalid_json", "Request body is not valid JSON.");
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!TOOL_NAME_PATTERN.test(name)) {
      return jsonError(400, "invalid_tool_name", "Tool name must match ^[A-Za-z0-9._-]{1,128}$.");
    }

    const rawUpstreamUrl = typeof body.upstreamUrl === "string" ? body.upstreamUrl : "";
    let validatedUrl: URL;
    try {
      validatedUrl = validateUpstreamUrl(rawUpstreamUrl);
    } catch (error) {
      if (error instanceof UpstreamUrlError) {
        return jsonError(400, error.code, error.message);
      }
      return jsonError(400, "ssrf_invalid_url", "Invalid upstream URL.");
    }

    const upstreamToolName = typeof body.upstreamToolName === "string" && body.upstreamToolName.trim()
      ? body.upstreamToolName.trim()
      : name;
    if (!TOOL_NAME_PATTERN.test(upstreamToolName)) {
      return jsonError(400, "invalid_upstream_tool_name", "upstreamToolName must match ^[A-Za-z0-9._-]{1,128}$.");
    }

    const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : "";
    const requiresApproval = body.requiresApproval === true;
    const idempotentCall = body.idempotent === true && !requiresApproval;
    const inputSchema = body.inputSchema === undefined
      ? { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: true }
      : body.inputSchema;

    try {
      compileInterpretedSchema(inputSchema, { label: name });
    } catch (error) {
      if (error instanceof GatewaySchemaError) {
        return jsonError(400, error.code, error.message, {}, { details: error.details });
      }
      return jsonError(400, "schema_invalid", "Tool inputSchema could not be compiled.");
    }

    let upstreamHeadersJson: string | null = null;
    if (body.headers !== undefined && body.headers !== null) {
      try {
        const normalized = normalizeUpstreamMcpHttpRequestHeaders(body.headers);
        upstreamHeadersJson = Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
      } catch {
        return jsonError(
          400,
          "upstream_mcp_headers_invalid",
          "headers must be a JSON object of declarative request headers: string values without control characters, no transport or hop-by-hop names, at most 64 headers and 32 KiB total.",
        );
      }
    }

    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO tools (name, description, kind, upstream_url, upstream_tool_name, upstream_headers_json, input_schema_json, requires_approval, idempotent_call, created_at)
       VALUES (?, ?, 'upstream_http_mcp', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         kind = excluded.kind,
         upstream_url = excluded.upstream_url,
         upstream_tool_name = excluded.upstream_tool_name,
         upstream_headers_json = excluded.upstream_headers_json,
         input_schema_json = excluded.input_schema_json,
         requires_approval = excluded.requires_approval,
         idempotent_call = excluded.idempotent_call`,
      name,
      description,
      validatedUrl.toString(),
      upstreamToolName,
      upstreamHeadersJson,
      JSON.stringify(inputSchema),
      requiresApproval ? 1 : 0,
      idempotentCall ? 1 : 0,
      now,
    );
    this.#schemaCache.delete(name);
    this.#invalidateUpstreamSessions({ toolName: name });

    this.#recordAudit({
      eventType: "tool.registered",
      toolName: name,
      decision: "allowed",
      detailCode: "ok",
    });

    const saved = this.#firstRow<ToolRow>("SELECT * FROM tools WHERE name = ?", name)!;
    return jsonResponse(201, { tool: this.#serializeTool(saved) });
  }

  #handleDeleteTool(toolName: string): Response {
    if (this.#isDemoMode()) {
      return jsonError(
        403,
        "demo_mode_tools_locked",
        "Demo tools cannot be modified in public demo mode.",
      );
    }
    const res = this.#sql.exec("DELETE FROM tools WHERE name = ? RETURNING name", toolName);
    if (res.toArray().length === 0) return jsonError(404, "tool_not_found", "Tool not found.");
    this.#schemaCache.delete(toolName);
    this.#invalidateUpstreamSessions({ toolName });
    this.#recordAudit({
      eventType: "tool.deleted",
      toolName,
      decision: "allowed",
      detailCode: "ok",
    });
    return jsonResponse(200, { ok: true, name: toolName });
  }

  #adminDecideEnabled(): boolean {
    return String(this.env.ADMIN_DECIDE_ENABLED ?? "true").trim().toLowerCase() !== "false";
  }

  #entioInstance(): string {
    const value = typeof this.env.ENTIO_INSTANCE === "string" ? this.env.ENTIO_INSTANCE.trim() : "";
    return value || "meshrix-mcp-gateway";
  }

  async #handleDecideApproval(approvalId: string, request: Request): Promise<Response> {
    if (!this.#adminDecideEnabled()) {
      return jsonError(403, "admin_decide_disabled", "Admin-token approval decisions are disabled by configuration.");
    }
    const bodyResult = await readBoundedText(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) return jsonError(bodyResult.status, bodyResult.error, bodyResult.message);

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyResult.text);
      if (!isPlainRecord(parsed)) return jsonError(400, "invalid_request", "Request body must be a JSON object.");
      body = parsed;
    } catch {
      return jsonError(400, "invalid_json", "Request body is not valid JSON.");
    }

    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny") {
      return jsonError(400, "invalid_decision", "decision must be 'approve' or 'deny'.");
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;
    const newStatus = decision === "approve" ? "approved" : "denied";
    const now = Date.now();

    const updateRows = this.#sql.exec(
      `UPDATE approvals
       SET status = ?, decided_at = ?, decision_reason = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?
       RETURNING *`,
      newStatus,
      now,
      reason,
      approvalId,
      now,
    ).toArray() as unknown as ApprovalRow[];

    if (updateRows.length !== 1) {
      const row = this.#firstRow<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", approvalId);
      if (!row) return jsonError(404, "approval_not_found", "Approval request not found.");
      return jsonError(409, "approval_not_pending", "Approval is no longer pending (already decided, consumed, or expired).", {}, {
        approval: this.#serializeApproval(row, now),
      });
    }

    const row = updateRows[0]!;
    this.#recordAudit({
      eventType: decision === "approve" ? "approval.approved" : "approval.denied",
      keyId: row.key_id,
      toolName: row.tool_name,
      argsSha256: row.args_sha256,
      decision: newStatus,
      detailCode: "ok",
      approvalId: row.id,
    });

    return jsonResponse(200, { ok: true, approval: this.#serializeApproval(row, now) });
  }

  // --- Entio signed approvals (docs/entio-approvals.md) ---

  #entioUnavailable(): Response | null {
    if (!this.#isDemoMode()) return null;
    return jsonError(403, "entio_unavailable", "Entio pairings are not supported on the public demo deployment.");
  }

  async #entioRelayJson(
    pairing: EntioPairingRow,
    method: string,
    subpath: string,
    body?: string,
  ): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
    try {
      const res = await fetch(`${pairing.relay}${subpath}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-entio-secret": pairing.secret,
        },
        body,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) return { status: res.status, json: null };
      let json: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(await res.text());
        if (isPlainRecord(parsed)) json = parsed;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  #consumeApprovalPermit(approvalId: string, keyId: string, toolName: string, argsSha256: string, now: number): boolean {
    const cursor = this.#sql.exec(
      `UPDATE approvals
       SET status = 'consumed', consumed_at = ?
       WHERE id = ?
         AND status = 'approved'
         AND key_id = ?
         AND tool_name = ?
         AND args_sha256 = ?
         AND consumed_at IS NULL
         AND expires_at > ?
       RETURNING id`,
      now,
      approvalId,
      keyId,
      toolName,
      argsSha256,
      now,
    );
    return cursor.toArray().length === 1 && cursor.rowsWritten >= 1;
  }

  #allLivePairings(): EntioPairingRow[] {
    return this.#allRows<EntioPairingRow>("SELECT * FROM entio_pairings ORDER BY label ASC LIMIT ?", MAX_ENTIO_PAIRINGS);
  }

  async #dispatchEntio(approval: ApprovalRow): Promise<void> {
    if (this.#isDemoMode()) return;
    const pairings = this.#allLivePairings();
    const now = Date.now();
    for (const pairing of pairings) {
      const requestJson = JSON.stringify(
        buildApprovalRequest({
          pair: pairing.pair,
          instance: this.#entioInstance(),
          approvalId: approval.id,
          keyId: approval.key_id,
          keyName: approval.key_name,
          toolName: approval.tool_name,
          argsSha256: approval.args_sha256,
          issuedAt: approval.created_at,
          expiresAt: approval.expires_at,
          nonce: randomBase64Url(24),
        }),
      );
      const digest = await requestDigest(JSON.parse(requestJson));
      const requestId = randomId("enr");
      let relayRid: string | null = null;
      let status = "dispatch_failed";
      let detail: string | null = null;
      const res = await this.#entioRelayJson(pairing, "POST", `/pair/${pairing.pair}/requests`, requestJson);
      if (res === null) {
        detail = "relay_unreachable";
      } else if (res.status === 200 && res.json && typeof res.json.request_id === "string" && res.json.request_id) {
        relayRid = res.json.request_id;
        status = "queued";
      } else {
        detail = `relay_http_${res.status}`;
      }
      this.#sql.exec(
        `INSERT INTO entio_requests
           (id, approval_id, pairing_label, relay_rid, request_json, request_digest, status, detail,
            issued_at, expires_at, decided_at, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        requestId,
        approval.id,
        pairing.label,
        relayRid,
        requestJson,
        digest,
        status,
        detail,
        approval.created_at,
        approval.expires_at,
        now,
      );
    }
    this.#pruneEntioRequests();
  }

  #pruneEntioRequests(): void {
    this.#sql.exec(
      `DELETE FROM entio_requests
       WHERE id NOT IN (SELECT id FROM entio_requests ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      MAX_STORED_ENTIO_REQUESTS,
    );
  }

  #markEntioRequest(id: string, status: string, detail: string | null, decision?: string | null): void {
    this.#sql.exec(
      `UPDATE entio_requests SET status = ?, detail = ?, decided_at = COALESCE(?, decided_at), decision = COALESCE(?, decision)
       WHERE id = ?`,
      status,
      detail,
      decision != null ? Date.now() : null,
      decision ?? null,
      id,
    );
  }

  /** Poll the relay for live dispatches of one pending approval and evaluate conclusions. */
  async #settleEntioApproval(approvalId: string): Promise<void> {
    if (this.#isDemoMode()) return;
    const approval = this.#firstRow<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", approvalId);
    if (!approval || approval.status !== "pending") return;
    const now = Date.now();
    const liveRows = this.#allRows<EntioRequestRow>(
      `SELECT * FROM entio_requests
       WHERE approval_id = ? AND status IN ('queued', 'dispatch_failed')
       ORDER BY created_at ASC`,
      approvalId,
    );
    if (liveRows.length === 0) return;
    if (approval.expires_at <= now) {
      for (const row of liveRows) this.#markEntioRequest(row.id, "expired", null);
      return;
    }
    for (const row of liveRows) {
      const pairing = this.#firstRow<EntioPairingRow>(
        "SELECT * FROM entio_pairings WHERE label = ?",
        row.pairing_label,
      );
      if (!pairing) {
        this.#markEntioRequest(row.id, "orphaned", "pairing_removed");
        continue;
      }
      let rid = row.relay_rid;
      if (!rid) {
        // A failed dispatch is retried once per settle pass with the same stored request.
        const res = await this.#entioRelayJson(pairing, "POST", `/pair/${pairing.pair}/requests`, row.request_json);
        if (res !== null && res.status === 200 && res.json && typeof res.json.request_id === "string" && res.json.request_id) {
          rid = res.json.request_id;
          this.#sql.exec(
            "UPDATE entio_requests SET relay_rid = ?, status = 'queued', detail = NULL WHERE id = ?",
            rid,
            row.id,
          );
        } else {
          this.#markEntioRequest(row.id, "dispatch_failed", res === null ? "relay_unreachable" : `relay_http_${res.status}`);
          continue;
        }
      }
      const encodedRid = encodeURIComponent(rid);
      const res = await this.#entioRelayJson(pairing, "GET", `/pair/${pairing.pair}/result?request=${encodedRid}`);
      if (res === null) continue; // transport failure — keep queued for the next poll
      const state = typeof res.json?.state === "string" ? res.json.state : "";
      if (state === "pending") continue;
      if ((state === "approved" || state === "rejected") && res.json && isPlainRecord(res.json.conclusion)) {
        let request: unknown;
        try {
          request = JSON.parse(row.request_json);
        } catch {
          this.#markEntioRequest(row.id, "invalid", "stored_request_corrupt");
          continue;
        }
        const verdict = await evaluateConclusion(request, res.json.conclusion, now, pairing.pubkey);
        if (verdict.kind === "approved") {
          const settled = this.#sql.exec(
            `UPDATE approvals SET status = 'approved', decided_at = ?, decision_reason = ?
             WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id`,
            now,
            `entio:${pairing.label}`,
            approvalId,
            now,
          );
          this.#markEntioRequest(row.id, "concluded", null, "approved");
          if (settled.toArray().length === 1) {
            this.#recordAudit({
              eventType: "approval.approved",
              keyId: approval.key_id,
              toolName: approval.tool_name,
              argsSha256: approval.args_sha256,
              decision: "approved",
              detailCode: "entio_signed",
              approvalId,
            });
            await this.#cancelRemainingEntioRequests(approvalId, row.id);
          }
        } else if (verdict.kind === "rejected") {
          const settled = this.#sql.exec(
            `UPDATE approvals SET status = 'denied', decided_at = ?, decision_reason = ?
             WHERE id = ? AND status = 'pending' RETURNING id`,
            now,
            `entio:${pairing.label}:rejected`,
            approvalId,
          );
          this.#markEntioRequest(row.id, "concluded", null, "rejected");
          if (settled.toArray().length === 1) {
            this.#recordAudit({
              eventType: "approval.denied",
              keyId: approval.key_id,
              toolName: approval.tool_name,
              argsSha256: approval.args_sha256,
              decision: "denied",
              detailCode: "entio_signed",
              approvalId,
            });
            await this.#cancelRemainingEntioRequests(approvalId, row.id);
          }
        } else {
          this.#markEntioRequest(row.id, "invalid", verdict.reason);
          this.#recordAudit({
            eventType: "approval.entio_conclusion",
            keyId: approval.key_id,
            toolName: approval.tool_name,
            argsSha256: approval.args_sha256,
            decision: "denied",
            detailCode: "entio_invalid",
            approvalId,
          });
        }
      } else if (state === "expired" || state === "cancelled" || state === "unknown") {
        this.#markEntioRequest(row.id, state === "unknown" ? "lost" : state, null);
      } else {
        this.#markEntioRequest(row.id, "invalid", `relay_state:${state || `http_${res.status}`}`);
      }
    }
  }

  async #cancelRemainingEntioRequests(approvalId: string, keepId: string): Promise<void> {
    const rows = this.#allRows<EntioRequestRow>(
      `SELECT * FROM entio_requests WHERE approval_id = ? AND status = 'queued' AND relay_rid IS NOT NULL AND id != ?`,
      approvalId,
      keepId,
    );
    for (const row of rows) {
      const pairing = this.#firstRow<EntioPairingRow>(
        "SELECT * FROM entio_pairings WHERE label = ?",
        row.pairing_label,
      );
      if (pairing && row.relay_rid) {
        await this.#entioRelayJson(
          pairing,
          "POST",
          `/pair/${pairing.pair}/cancel`,
          JSON.stringify({ request_id: row.relay_rid }),
        );
      }
      this.#markEntioRequest(row.id, "cancelled", null);
    }
  }

  async #handleRegisterPairing(request: Request): Promise<Response> {
    const unavailable = this.#entioUnavailable();
    if (unavailable) return unavailable;
    const bodyResult = await readBoundedText(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) return jsonError(bodyResult.status, bodyResult.error, bodyResult.message);

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyResult.text);
      if (!isPlainRecord(parsed)) return jsonError(400, "invalid_request", "Request body must be a JSON object.");
      body = parsed;
    } catch {
      return jsonError(400, "invalid_json", "Request body is not valid JSON.");
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!ENTIO_LABEL_PATTERN.test(label)) {
      return jsonError(400, "invalid_label", "label must match [A-Za-z0-9._-]{1,64}.");
    }

    let pair = typeof body.pair === "string" ? body.pair.trim() : "";
    let secret = typeof body.secret === "string" ? body.secret : "";
    let relay = typeof body.relay === "string" ? body.relay.trim() : "";
    if (typeof body.pairCode === "string" && body.pairCode.trim()) {
      const parsed = parsePairCode(body.pairCode);
      if (!parsed) return jsonError(400, "invalid_pair_code", "pairCode must be entio://pair?i=<uuid>&s=<secret>[&r=<relay>].");
      pair = parsed.pair;
      secret = parsed.secret;
      if (parsed.relay) relay = parsed.relay;
    }
    if (!isPairId(pair)) return jsonError(400, "invalid_pair", "pair must be the pairing UUID.");
    if (!secret || secret.length > 256 || /[\x00-\x1f]/u.test(secret)) {
      return jsonError(400, "invalid_secret", "secret is required and must be ≤256 printable chars.");
    }
    let relayBase: string;
    try {
      relayBase = validateRelayBaseUrl(relay);
    } catch (error) {
      if (error instanceof UpstreamUrlError) {
        return jsonError(400, error.code, error.message);
      }
      throw error;
    }
    const pubkey = typeof body.pubkey === "string" ? body.pubkey.trim() : "";
    if (!pubkey || !(await validateApproverPubkey(pubkey))) {
      return jsonError(400, "invalid_pubkey", "pubkey must be the base64 x9.63 P-256 device key shown at pairing.");
    }
    const fingerprint = (await pubkeyFingerprint(pubkey)) ?? "";

    const existing = this.#firstRow<EntioPairingRow>("SELECT * FROM entio_pairings WHERE label = ?", label);
    if (!existing) {
      const count = this.#firstRow<{ readonly n: number }>("SELECT COUNT(*) AS n FROM entio_pairings")!.n;
      if (count >= MAX_ENTIO_PAIRINGS) {
        return jsonError(409, "too_many_pairings", `At most ${MAX_ENTIO_PAIRINGS} Entio pairings can be registered.`);
      }
    }
    const now = Date.now();
    this.#sql.exec(
      `INSERT INTO entio_pairings (label, relay, pair, secret, pubkey, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         relay = excluded.relay, pair = excluded.pair, secret = excluded.secret,
         pubkey = excluded.pubkey, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
      label,
      relayBase,
      pair,
      secret,
      pubkey,
      fingerprint,
      now,
      now,
    );
    this.#recordAudit({
      eventType: existing ? "entio.pairing_rotated" : "entio.pairing_registered",
      decision: "allowed",
      detailCode: "ok",
    });
    const saved = this.#firstRow<EntioPairingRow>("SELECT * FROM entio_pairings WHERE label = ?", label)!;
    return jsonResponse(existing ? 200 : 201, { ok: true, pairing: this.#serializePairing(saved) });
  }

  #handleDeletePairing(labelRaw: string): Response {
    const unavailable = this.#entioUnavailable();
    if (unavailable) return unavailable;
    const label = decodeURIComponent(labelRaw);
    if (!label || label.includes("/")) return jsonError(400, "invalid_label", "Invalid pairing label.");
    const cursor = this.#sql.exec("DELETE FROM entio_pairings WHERE label = ? RETURNING label", label);
    if (cursor.toArray().length !== 1) {
      return jsonError(404, "pairing_not_found", "Entio pairing not found.");
    }
    this.#recordAudit({ eventType: "entio.pairing_removed", decision: "allowed", detailCode: "ok" });
    return jsonResponse(200, { ok: true, label });
  }

  async #handleEntioRefresh(approvalId: string): Promise<Response> {
    const unavailable = this.#entioUnavailable();
    if (unavailable) return unavailable;
    if (!approvalId || approvalId.includes("/")) {
      return jsonError(400, "invalid_approval_id", "Invalid approval id.");
    }
    const row = this.#firstRow<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", approvalId);
    if (!row) return jsonError(404, "approval_not_found", "Approval request not found.");
    await this.#settleEntioApproval(approvalId);
    const now = Date.now();
    const fresh = this.#firstRow<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", approvalId)!;
    const requests = this.#allRows<EntioRequestRow>(
      "SELECT * FROM entio_requests WHERE approval_id = ? ORDER BY created_at ASC",
      approvalId,
    ).map((r) => this.#serializeEntioRequest(r));
    return jsonResponse(200, { ok: true, approval: this.#serializeApproval(fresh, now), entio: { requests } });
  }

  async #executeBuiltinTool(
    toolName: string,
    args: Record<string, unknown>,
    keyId: string,
    argsSha256: string,
    approvalId: string | null,
  ): Promise<Record<string, unknown>> {
    if (toolName === "demo.echo") {
      const payload = {
        echoed: args.message,
        tag: args.tag ?? null,
        keyId,
        timestamp: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }

    if (toolName === "demo.format_note") {
      const title = String(args.title);
      const body = String(args.body);
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
      const tagLine = tags.length > 0 ? `\n\nTags: ${tags.map((t) => `#${t}`).join(" ")}` : "";
      const markdown = `# ${title}\n\n${body}${tagLine}`;
      return {
        content: [{ type: "text", text: markdown }],
        structuredContent: { title, tags, markdown },
      };
    }

    if (toolName === "demo.sensitive_deploy") {
      const receipt = {
        deployed: true,
        service: args.service,
        environment: args.environment,
        version: args.version,
        dryRun: Boolean(args.dryRun),
        approvalId,
        argsSha256,
        timestamp: new Date().toISOString(),
      };
      return {
        content: [{ type: "text", text: `Deployment simulated with single-use approval ${approvalId ?? "direct"}: ${JSON.stringify(receipt)}` }],
        structuredContent: receipt,
      };
    }

    throw new Error(`Unsupported builtin tool: ${toolName}`);
  }

  #invalidateUpstreamSessions(filter: { readonly keyId?: string; readonly toolName?: string }): void {
    for (const [cacheKey, entry] of this.#upstreamSessions.entries()) {
      if ((filter.keyId && entry.keyId === filter.keyId) || (filter.toolName && entry.toolName === filter.toolName)) {
        this.#upstreamSessions.delete(cacheKey);
      }
    }
    for (const [cacheKey, entry] of this.#upstreamHandshakes.entries()) {
      if ((filter.keyId && entry.keyId === filter.keyId) || (filter.toolName && entry.toolName === filter.toolName)) {
        this.#upstreamHandshakes.delete(cacheKey);
      }
    }
  }

  #rememberUpstreamSession(cacheKey: string, scoped: ScopedUpstreamSession): void {
    this.#upstreamSessions.delete(cacheKey);
    if (this.#upstreamSessions.size >= MAX_UPSTREAM_SESSION_ENTRIES) {
      const oldest = this.#upstreamSessions.keys().next().value;
      if (oldest !== undefined) this.#upstreamSessions.delete(oldest);
    }
    this.#upstreamSessions.set(cacheKey, scoped);
  }

  #upstreamRequestHeaders(extraHeaders: Record<string, string>, session: UpstreamSession | null): Record<string, string> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (session) {
      headers["MCP-Protocol-Version"] = session.protocolVersion;
      if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
    }
    return headers;
  }

  async #postUpstream(
    url: string,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    session: UpstreamSession | null,
  ): Promise<{ readonly ok: true; readonly response: Response } | UpstreamCallFailure> {
    let response: Response;
    try {
      response = await safeUpstreamFetch(url, {
        method: "POST",
        headers: this.#upstreamRequestHeaders(extraHeaders, session),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof UpstreamUrlError) {
        if (error.notSent) {
          return { ok: false, code: error.code, message: error.message, notSent: true };
        }
        return { ok: false, code: error.code, message: error.message, resultUnknown: true };
      }
      // A rejected fetch cannot prove the request never arrived: it may have
      // reached the upstream before the transport failed.
      return { ok: false, code: "upstream_transport_failed", message: "Upstream MCP request failed.", resultUnknown: true };
    }
    return { ok: true, response };
  }

  async #sendUpstreamCall(
    url: string,
    expectedId: string | number,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    session: UpstreamSession | null,
  ): Promise<UpstreamCallOutcome> {
    const posted = await this.#postUpstream(url, payload, extraHeaders, session);
    if (!posted.ok) return posted;
    const { response } = posted;

    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      if (session?.sessionId) {
        return {
          ok: false,
          code: "upstream_session_invalid",
          message: "Upstream MCP server does not recognize the current session.",
          sessionExpired: true,
          evictCachedSession: true,
        };
      }
      return {
        ok: false,
        code: "upstream_http_error",
        message: "Upstream MCP server responded with HTTP 404.",
      };
    }

    const decoded = await readUpstreamJsonRpcMessage(response, expectedId, MAX_BODY_BYTES);
    if (!decoded.ok) {
      return {
        ok: false,
        code: "upstream_response_too_large",
        message: "Upstream MCP response exceeded byte budget.",
        resultUnknown: true,
      };
    }
    const { parsed } = decoded;

    if (!response.ok) {
      return {
        ok: false,
        code: "upstream_http_error",
        message: `Upstream MCP server responded with HTTP ${response.status}.`,
        resultUnknown: true,
      };
    }

    if (!parsed) {
      return {
        ok: false,
        code: "upstream_invalid_json",
        message: "Upstream MCP server returned invalid JSON-RPC.",
        resultUnknown: true,
      };
    }

    if (isPlainRecord(parsed.error)) {
      const upstreamCode = typeof parsed.error.code === "number" ? parsed.error.code : -32002;
      return {
        ok: false,
        code: "upstream_jsonrpc_error",
        message: "Upstream MCP server returned a JSON-RPC error.",
        upstreamCode,
      };
    }

    if (!isPlainRecord(parsed.result) || parsed.id !== expectedId) {
      return {
        ok: false,
        code: "upstream_invalid_result",
        message: "Upstream MCP response missed matching result payload.",
        resultUnknown: true,
      };
    }

    const returnedSessionId = readUpstreamSessionId(response);
    if (session?.sessionId && returnedSessionId && returnedSessionId !== session.sessionId) {
      // The tool already executed upstream: evict the stale cached session for
      // subsequent calls, never replay this call or restore its approval permit.
      return {
        ok: false,
        code: "upstream_session_invalid",
        message: "Upstream MCP server returned an unexpected session identifier.",
        evictCachedSession: true,
        resultUnknown: true,
      };
    }

    return { ok: true, result: parsed.result, returnedSessionId };
  }

  async #handshakeUpstream(
    cacheKey: string,
    keyId: string,
    toolName: string,
    url: string,
    extraHeaders: Record<string, string>,
  ): Promise<UpstreamHandshakeOutcome> {
    const pending = this.#upstreamHandshakes.get(cacheKey);
    if (pending) return pending.promise;
    const promise = this.#performUpstreamHandshake(url, extraHeaders).finally(() => {
      if (this.#upstreamHandshakes.get(cacheKey)?.promise === promise) {
        this.#upstreamHandshakes.delete(cacheKey);
      }
    });
    this.#upstreamHandshakes.set(cacheKey, { keyId, toolName, promise });
    return promise;
  }

  async #performUpstreamHandshake(url: string, extraHeaders: Record<string, string>): Promise<UpstreamHandshakeOutcome> {
    const initId = randomId("init");
    const initPayload = {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: SUPPORTED_MCP_VERSIONS[0],
        capabilities: {},
        clientInfo: GATEWAY_UPSTREAM_CLIENT_INFO,
      },
    };

    const posted = await this.#postUpstream(url, initPayload, extraHeaders, null);
    if (!posted.ok) {
      if (posted.notSent) return posted;
      return {
        ok: false,
        code: posted.code === "upstream_transport_failed" ? "upstream_handshake_failed" : posted.code,
        message: posted.message,
        ...(posted.resultUnknown ? { resultUnknown: true } : {}),
      };
    }
    const { response } = posted;
    const sessionId = readUpstreamSessionId(response);

    const decoded = await readUpstreamJsonRpcMessage(response, initId, MAX_BODY_BYTES);
    if (!decoded.ok) {
      return { ok: false, code: "upstream_handshake_failed", message: "Upstream MCP initialize response exceeded byte budget." };
    }
    const { parsed } = decoded;

    if (!response.ok) {
      // HTTP authentication, authorization, rate-limit, not-found, and 5xx
      // errors take strict precedence and never cache stateless capability.
      // Stateless fallback applies ONLY to HTTP 400 carrying a valid JSON-RPC
      // 2.0 -32601 (Method not found) response correlated to `initId`.
      const errObj =
        response.status === 400 &&
        parsed &&
        parsed.jsonrpc === "2.0" &&
        parsed.id === initId &&
        isPlainRecord(parsed.error)
          ? parsed.error
          : null;
      if (errObj && errObj.code === -32601) {
        return { ok: true, mode: "stateless", session: null };
      }
      return {
        ok: false,
        code: "upstream_handshake_failed",
        message: `Upstream MCP initialize failed with HTTP ${response.status}.`,
      };
    }
    if (!parsed || isPlainRecord(parsed.error)) {
      const errorRecord = parsed && isPlainRecord(parsed.error) ? parsed.error : null;
      const upstreamCode = errorRecord && typeof errorRecord.code === "number" ? errorRecord.code : undefined;
      if (parsed?.jsonrpc === "2.0" && parsed.id === initId && upstreamCode === -32601) {
        return { ok: true, mode: "stateless", session: null };
      }
      return {
        ok: false,
        code: "upstream_handshake_failed",
        message: "Upstream MCP server rejected the initialize handshake.",
        ...(upstreamCode !== undefined ? { upstreamCode } : {}),
      };
    }
    if (!isPlainRecord(parsed.result) || parsed.id !== initId) {
      return { ok: false, code: "upstream_handshake_failed", message: "Upstream MCP initialize returned no result." };
    }

    const negotiated =
      typeof parsed.result.protocolVersion === "string" && UPSTREAM_VISIBLE_TOKEN_PATTERN.test(parsed.result.protocolVersion)
        ? parsed.result.protocolVersion
        : SUPPORTED_MCP_VERSIONS[0];
    const session: UpstreamSession = { sessionId, protocolVersion: negotiated };

    const notified = await this.#postUpstream(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      extraHeaders,
      session,
    );
    if (!notified.ok) {
      return {
        ok: false,
        code: notified.code === "upstream_transport_failed" ? "upstream_handshake_failed" : notified.code,
        message: notified.message,
        ...(notified.resultUnknown ? { resultUnknown: true } : {}),
      };
    }
    if (!notified.response.ok) {
      await notified.response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        code: "upstream_handshake_failed",
        message: `Upstream MCP initialized notification failed with HTTP ${notified.response.status}.`,
      };
    }
    await notified.response.body?.cancel().catch(() => undefined);

    return { ok: true, mode: "stateful", session };
  }

  async #executeUpstreamTool(
    tool: ToolRow,
    args: Record<string, unknown>,
    callerKeyId: string,
  ): Promise<UpstreamCallOutcome> {
    if (!tool.upstream_url) {
      return { ok: false, code: "upstream_unconfigured", message: "Upstream URL is missing.", notSent: true };
    }
    const url = tool.upstream_url;
    const extraHeaders = this.#upstreamHeaders(tool);
    const replaySafeIdempotent = tool.idempotent_call === 1 && tool.requires_approval === 0;
    const cacheKey = await sha256Hex(
      canonicalJson({
        keyId: callerKeyId,
        toolName: tool.name,
        url,
        headers: extraHeaders,
      }),
    );

    // Establish or reuse the upstream session BEFORE sending tools/call so
    // non-idempotent / approval-gated tools never dispatch tools/call twice.
    let cached = this.#upstreamSessions.get(cacheKey) ?? null;
    if (!cached) {
      const handshake = await this.#handshakeUpstream(cacheKey, callerKeyId, tool.name, url, extraHeaders);
      if (!handshake.ok) {
        // tools/call was never dispatched: mark notSent so any single-use
        // approval permit is restored to approved rather than lost to a
        // pre-dispatch handshake failure.
        return {
          ok: false,
          code: handshake.code,
          message: handshake.message,
          ...(handshake.upstreamCode !== undefined ? { upstreamCode: handshake.upstreamCode } : {}),
          notSent: true,
        };
      }
      cached = {
        keyId: callerKeyId,
        toolName: tool.name,
        mode: handshake.mode,
        session: handshake.session,
      };
      this.#rememberUpstreamSession(cacheKey, cached);
    }

    const callId = randomId("call");
    const callPayload = {
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: tool.upstream_tool_name ?? tool.name,
        arguments: args,
      },
    };

    let session = cached.session;
    let outcome = await this.#sendUpstreamCall(url, callId, callPayload, extraHeaders, session);

    const evictIfSameSession = (targetSession: UpstreamSession | null): void => {
      const current = this.#upstreamSessions.get(cacheKey);
      if (current && current.session?.sessionId === targetSession?.sessionId) {
        this.#upstreamSessions.delete(cacheKey);
      }
    };

    if (!outcome.ok && outcome.evictCachedSession) {
      evictIfSameSession(session);
    }

    // Re-handshake and retry ONLY when the tool explicitly declares replay-safe
    // idempotency (never on approval-gated or default side-effecting tools) AND
    // a session-bearing call received MCP's HTTP 404 session-expired status.
    if (!outcome.ok && outcome.sessionExpired && replaySafeIdempotent) {
      const concurrentCached = this.#upstreamSessions.get(cacheKey);
      if (concurrentCached && concurrentCached.session?.sessionId && concurrentCached.session.sessionId !== session?.sessionId) {
        cached = concurrentCached;
      } else {
        const handshake = await this.#handshakeUpstream(cacheKey, callerKeyId, tool.name, url, extraHeaders);
        if (!handshake.ok) {
          return handshake;
        }
        cached = {
          keyId: callerKeyId,
          toolName: tool.name,
          mode: handshake.mode,
          session: handshake.session,
        };
        this.#rememberUpstreamSession(cacheKey, cached);
      }
      session = cached.session;
      const retryId = randomId("call");
      outcome = await this.#sendUpstreamCall(
        url,
        retryId,
        { ...callPayload, id: retryId },
        extraHeaders,
        session,
      );
      if (!outcome.ok) {
        if (outcome.evictCachedSession || outcome.sessionExpired) {
          evictIfSameSession(session);
        }
        if (outcome.sessionExpired) {
          return {
            ok: false,
            code: "upstream_session_expired",
            message: "Upstream MCP server rejected the session even after a fresh handshake.",
          };
        }
        return outcome;
      }
    } else if (!outcome.ok && outcome.sessionExpired) {
      return {
        ok: false,
        code: "upstream_session_expired",
        message: "Upstream MCP session expired; side-effecting call was not replayed.",
        resultUnknown: true,
      };
    }

    if (outcome.ok && outcome.returnedSessionId && outcome.returnedSessionId !== session?.sessionId) {
      this.#rememberUpstreamSession(cacheKey, {
        keyId: callerKeyId,
        toolName: tool.name,
        mode: "stateful",
        session: {
          sessionId: outcome.returnedSessionId,
          protocolVersion: session?.protocolVersion ?? SUPPORTED_MCP_VERSIONS[0],
        },
      });
    }

    return outcome;
  }

  async #handleMcp(request: Request): Promise<Response> {
    if (request.method === "DELETE") {
      const auth = await this.#authenticateApiKey(request);
      if (!auth.ok) {
        return mcpError(auth.status, null, -32001, auth.message, { code: auth.code }, {
          "WWW-Authenticate": "Bearer",
        });
      }
      return jsonResponse(200, { ok: true });
    }

    if (request.method !== "POST") {
      return jsonError(405, "method_not_allowed", "Use POST /mcp for MCP JSON-RPC requests.", {
        Allow: "POST, DELETE, OPTIONS",
      });
    }

    const auth = await this.#authenticateApiKey(request);
    if (!auth.ok) {
      return mcpError(auth.status, null, -32001, auth.message, { code: auth.code }, {
        "WWW-Authenticate": "Bearer",
      });
    }

    const bodyResult = await readBoundedText(request, MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      return mcpError(bodyResult.status, null, -32600, bodyResult.message, { code: bodyResult.error });
    }

    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bodyResult.text);
      if (!isPlainRecord(parsed)) {
        return mcpError(400, null, -32600, "Invalid JSON-RPC request.");
      }
      message = parsed;
    } catch {
      return mcpError(400, null, -32700, "Parse error.");
    }

    const id = message.id;
    const method = message.method;
    if (message.jsonrpc !== "2.0" || typeof method !== "string" || !method) {
      return mcpError(400, id ?? null, -32600, "Invalid JSON-RPC 2.0 envelope.");
    }
    if (message.params !== undefined && !isPlainRecord(message.params)) {
      return mcpError(400, id ?? null, -32602, "JSON-RPC params must be an object.");
    }
    const params = isPlainRecord(message.params) ? message.params : {};

    // Notifications (no id, or notifications/*) return 202 Accepted per MCP Streamable HTTP
    if (id === undefined || method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }

    const now = Date.now();
    if (auth.key.last_used_at === null || now - auth.key.last_used_at >= KEY_LAST_USED_DEBOUNCE_MS) {
      this.#sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now, auth.key.id);
    }

      if (method === "initialize") {
      const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const negotiated = (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requestedVersion)
        ? requestedVersion
        : SUPPORTED_MCP_VERSIONS[0];
      return mcpResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: GATEWAY_UPSTREAM_CLIENT_INFO,
      });
    }

    if (method === "ping") {
      return mcpResult(id, {});
    }

    if (method === "tools/list") {
      const scopeSet = new Set(auth.allowedTools);
      const visibleTools = this.#allRows<ToolRow>("SELECT * FROM tools ORDER BY name ASC")
        .filter((tool) => scopeSet.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: JSON.parse(tool.input_schema_json) as unknown,
          annotations: {
            requiresApproval: tool.requires_approval === 1,
          },
        }));
      this.#recordAudit({
        eventType: "mcp.tools_list",
        keyId: auth.key.id,
        decision: "allowed",
        detailCode: "ok",
      });
      return mcpResult(id, { tools: visibleTools });
    }

    if (method === "tools/call") {
      const startedAt = Date.now();
      const toolName = typeof params.name === "string" ? params.name.trim() : "";
      if (!toolName) {
        return mcpError(200, id, -32602, "tools/call requires a non-empty string params.name.");
      }
      if (params.arguments !== undefined && !isPlainRecord(params.arguments)) {
        return mcpError(200, id, -32602, "tools/call params.arguments must be an object.");
      }
      const args = isPlainRecord(params.arguments) ? params.arguments : {};

      const tool = this.#firstRow<ToolRow>("SELECT * FROM tools WHERE name = ? LIMIT 1", toolName);
      if (!tool) {
        this.#recordAudit({
          eventType: "mcp.tool_call",
          keyId: auth.key.id,
          toolName,
          decision: "denied",
          detailCode: "tool_not_found",
          latencyMs: Date.now() - startedAt,
        });
        return mcpError(200, id, -32602, `Unknown tool: ${toolName}`, { code: "tool_not_found" });
      }

      if (!auth.allowedTools.includes(tool.name)) {
        this.#recordAudit({
          eventType: "mcp.tool_call",
          keyId: auth.key.id,
          toolName: tool.name,
          decision: "denied",
          detailCode: "tool_not_in_scope",
          latencyMs: Date.now() - startedAt,
        });
        return mcpError(200, id, -32003, `Tool '${tool.name}' is outside this API key's allowedTools scope.`, {
          code: "tool_not_in_scope",
          toolName: tool.name,
        });
      }

      const argsSha256 = await sha256Hex(canonicalJson(args));

      try {
        const compiled = this.#getCompiledSchema(tool);
        compiled.assertValid(args);
      } catch (error) {
        const schemaErr = error instanceof GatewaySchemaError ? error : null;
        this.#recordAudit({
          eventType: "mcp.tool_call",
          keyId: auth.key.id,
          toolName: tool.name,
          argsSha256,
          decision: "denied",
          detailCode: schemaErr?.code ?? "schema_validation_failed",
          latencyMs: Date.now() - startedAt,
        });
        return mcpError(200, id, -32602, schemaErr?.message ?? "Tool arguments failed schema validation.", {
          code: schemaErr?.code ?? "schema_validation_failed",
          ...(schemaErr?.details ?? {}),
        });
      }

      let consumedApprovalId: string | null = null;
      let consumedApprovalAt: number | null = null;
      if (tool.requires_approval === 1) {
        const meta = isPlainRecord(params._meta) ? params._meta : {};
        const rawApprovalId =
          typeof meta.approvalId === "string" ? meta.approvalId.trim()
          : typeof meta["io.meshrix/approvalId"] === "string" ? meta["io.meshrix/approvalId"].trim()
          : typeof params.approvalId === "string" ? params.approvalId.trim()
          : (request.headers.get("x-meshrix-approval-id") ?? "").trim();

        const checkNow = Date.now();
        if (rawApprovalId) {
          await this.#settleEntioApproval(rawApprovalId);
          const consumeNow = Date.now();
          if (!this.#consumeApprovalPermit(rawApprovalId, auth.key.id, tool.name, argsSha256, consumeNow)) {
            this.#recordAudit({
              eventType: "mcp.tool_call",
              keyId: auth.key.id,
              toolName: tool.name,
              argsSha256,
              decision: "denied",
              detailCode: "approval_replay_or_mismatch",
              approvalId: rawApprovalId,
              latencyMs: Date.now() - startedAt,
            });
            return mcpError(
              200,
              id,
              -32003,
              "Approval permit is missing, already consumed, expired, or does not match key, tool, and arguments.",
              {
                code: "approval_replay_or_mismatch",
                approvalId: rawApprovalId,
              },
            );
          }
          consumedApprovalId = rawApprovalId;
          consumedApprovalAt = consumeNow;
        } else {
          const matchingApproved = this.#firstRow<{ readonly id: string }>(
            `SELECT id FROM approvals
             WHERE key_id = ? AND tool_name = ? AND args_sha256 = ?
               AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?
             ORDER BY decided_at DESC, created_at DESC LIMIT 1`,
            auth.key.id,
            tool.name,
            argsSha256,
            checkNow,
          );

          if (matchingApproved) {
            const consumeNow = Date.now();
            if (this.#consumeApprovalPermit(matchingApproved.id, auth.key.id, tool.name, argsSha256, consumeNow)) {
              consumedApprovalId = matchingApproved.id;
              consumedApprovalAt = consumeNow;
            }
          }

          let pendingApprovalId: string | null = null;
          if (!consumedApprovalId) {
            const pendingMatch = this.#firstRow<{ readonly id: string }>(
              `SELECT id FROM approvals
               WHERE key_id = ? AND tool_name = ? AND args_sha256 = ?
                 AND status = 'pending' AND expires_at > ?
               ORDER BY created_at DESC LIMIT 1`,
              auth.key.id,
              tool.name,
              argsSha256,
              checkNow,
            );
            if (pendingMatch) {
              // Lazily poll the relay: a phone-signed conclusion may have landed.
              await this.#settleEntioApproval(pendingMatch.id);
              const consumeNow = Date.now();
              if (this.#consumeApprovalPermit(pendingMatch.id, auth.key.id, tool.name, argsSha256, consumeNow)) {
                consumedApprovalId = pendingMatch.id;
                consumedApprovalAt = consumeNow;
              } else {
                pendingApprovalId = pendingMatch.id;
              }
            }
          }

          if (!consumedApprovalId) {
            let effectiveId = pendingApprovalId;
            if (!effectiveId) {
              const newApprovalId = randomId("apr");
              this.#sql.exec(
                `INSERT INTO approvals (id, key_id, key_name, tool_name, args_sha256, args_preview, status, decision_reason, created_at, expires_at, decided_at, consumed_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)
                 RETURNING *`,
                newApprovalId,
                auth.key.id,
                auth.key.name,
                tool.name,
                argsSha256,
                redactArgsPreview(args),
                checkNow,
                checkNow + APPROVAL_TTL_MS,
              );
              this.#pruneApprovals();
              const newApproval = this.#firstRow<ApprovalRow>("SELECT * FROM approvals WHERE id = ?", newApprovalId)!;
              await this.#dispatchEntio(newApproval);
              effectiveId = newApprovalId;
              this.#recordAudit({
                eventType: "approval.requested",
                keyId: auth.key.id,
                toolName: tool.name,
                argsSha256,
                decision: "approval_required",
                detailCode: "approval_required",
                approvalId: newApprovalId,
                latencyMs: Date.now() - startedAt,
              });
            }
            return mcpError(
              200,
              id,
              -32003,
              `Human approval required before executing '${tool.name}'.`,
              {
                code: "approval_required",
                approvalId: effectiveId,
                toolName: tool.name,
                argsSha256,
              },
            );
          }
        }
      }

      if (tool.kind === "builtin") {
        const result = await this.#executeBuiltinTool(
          tool.name,
          args,
          auth.key.id,
          argsSha256,
          consumedApprovalId,
        );
        this.#recordAudit({
          eventType: "mcp.tool_call",
          keyId: auth.key.id,
          toolName: tool.name,
          argsSha256,
          decision: "allowed",
          detailCode: consumedApprovalId ? "approval_consumed" : "ok",
          approvalId: consumedApprovalId,
          latencyMs: Date.now() - startedAt,
        });
        return mcpResult(id, result);
      }

      const upstream = await this.#executeUpstreamTool(tool, args, auth.key.id);
      if (!upstream.ok) {
        // The permit is consumed before dispatch to block replay, but a failure
        // provably raised before the request reached the upstream endpoint
        // restores it to approved so it can be redeemed once more. A failure
        // that may already have arrived keeps the permit consumed and the
        // receipt marks the upstream result as unknown.
        const approvalRestored =
          upstream.notSent === true &&
          consumedApprovalId !== null &&
          consumedApprovalAt !== null &&
          this.#sql.exec(
            `UPDATE approvals
             SET status = 'approved', consumed_at = NULL
             WHERE id = ? AND status = 'consumed' AND consumed_at = ?
             RETURNING id`,
            consumedApprovalId,
            consumedApprovalAt,
          ).toArray().length === 1;
        this.#recordAudit({
          eventType: "mcp.tool_call",
          keyId: auth.key.id,
          toolName: tool.name,
          argsSha256,
          decision: "error",
          detailCode: upstream.code,
          approvalId: consumedApprovalId,
          latencyMs: Date.now() - startedAt,
        });
        if (approvalRestored) {
          this.#recordAudit({
            eventType: "approval.restored",
            keyId: auth.key.id,
            toolName: tool.name,
            argsSha256,
            decision: "approved",
            detailCode: upstream.code,
            approvalId: consumedApprovalId,
            latencyMs: Date.now() - startedAt,
          });
        }
        return mcpError(200, id, upstream.upstreamCode ?? -32002, upstream.message, {
          code: upstream.code,
          ...(consumedApprovalId !== null ? { approvalId: consumedApprovalId } : {}),
          ...(approvalRestored ? { approvalRestored: true } : {}),
          ...(upstream.resultUnknown === true ? { resultUnknown: true } : {}),
        });
      }

      this.#recordAudit({
        eventType: "mcp.tool_call",
        keyId: auth.key.id,
        toolName: tool.name,
        argsSha256,
        decision: "allowed",
        detailCode: consumedApprovalId ? "approval_consumed" : "ok",
        approvalId: consumedApprovalId,
        latencyMs: Date.now() - startedAt,
      });
      return mcpResult(id, upstream.result);
    }

    return mcpError(200, id, -32601, `Method not found: ${method}`);
  }

  async fetch(request: Request): Promise<Response> {
    this.#ensureInitialized();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/mcp") {
      return this.#handleMcp(request);
    }

    if (path.startsWith("/admin/")) {
      const adminDenied = await this.#authorizeAdmin(request);
      if (adminDenied) return adminDenied;

      if (request.method === "GET" && path === "/admin/state") {
        return this.#handleAdminState(request);
      }
      if (request.method === "POST" && path === "/admin/keys") {
        return this.#handleMintKey(request);
      }
      if (request.method === "DELETE" && path.startsWith("/admin/keys/")) {
        const keyId = decodeURIComponent(path.slice("/admin/keys/".length));
        if (!keyId || keyId.includes("/")) return jsonError(400, "invalid_key_id", "Invalid key id.");
        return this.#handleRevokeKey(request, keyId);
      }
      if (request.method === "POST" && path === "/admin/tools") {
        return this.#handleRegisterTool(request);
      }
      if (request.method === "DELETE" && path.startsWith("/admin/tools/")) {
        const toolName = decodeURIComponent(path.slice("/admin/tools/".length));
        if (!toolName || toolName.includes("/")) return jsonError(400, "invalid_tool_name", "Invalid tool name.");
        return this.#handleDeleteTool(toolName);
      }
      if (request.method === "POST" && path.startsWith("/admin/approvals/") && path.endsWith("/decide")) {
        const inner = path.slice("/admin/approvals/".length, -"/decide".length);
        const approvalId = decodeURIComponent(inner);
        if (!approvalId || approvalId.includes("/")) return jsonError(400, "invalid_approval_id", "Invalid approval id.");
        return this.#handleDecideApproval(approvalId, request);
      }
      if (request.method === "POST" && path.startsWith("/admin/approvals/") && path.endsWith("/entio-refresh")) {
        const inner = path.slice("/admin/approvals/".length, -"/entio-refresh".length);
        const approvalId = decodeURIComponent(inner);
        return this.#handleEntioRefresh(approvalId);
      }
      if (request.method === "POST" && path === "/admin/entio/pairings") {
        return this.#handleRegisterPairing(request);
      }
      if (request.method === "DELETE" && path.startsWith("/admin/entio/pairings/")) {
        return this.#handleDeletePairing(path.slice("/admin/entio/pairings/".length));
      }

      return jsonError(404, "not_found", "Admin route not found.");
    }

    return jsonError(404, "not_found", "Route not found.");
  }
}
