/**
 * strict-json-body-parser — Strict JSON body parsing for HTTP/RPC requests.
 *
 * Rejects illegal JSON with 400 invalid_json instead of silently returning {}.
 * Records redacted parse error metadata for audit (size, content-type) but
 * NEVER records the raw body.
 *
 * @module foundation/serialization/strict-json-body-parser
 */

import { canonicalHash } from "./canonical-json.ts";

const MAX_BODY_SIZE_DEFAULT: any = 10 * 1024 * 1024; // 10MB

/**
 * Parse a request body string as strict JSON.
 * @param {string} body - Raw body string
 * @param {object} [options]
 * @param {number} [options.maxBodySize=10485760] - Maximum body size in bytes
 * @param {string} [options.contentType] - Content-Type header for error reporting
 * @param {string} [options.traceId] - Trace ID for error reporting
 * @returns {{ success: true, data: object } | { success: false, error: object }}
 */
export function parseStrictJsonBody(body?: any, options: Record<string, any> = {}) : any {
  const maxBodySize: any = Number(options.maxBodySize) || MAX_BODY_SIZE_DEFAULT;
  const contentType: any = String(options.contentType || "application/json");
  const traceId: any = String(options.traceId || "");

  // Null/undefined body
  if (body === null || body === undefined) {
    return {
      success: false,
      error: _buildError("empty_body", "Request body is empty.", {
        contentType,
        traceId,
      }),
    };
  }

  const bodyStr: any = typeof body === "string" ? body : String(body);
  const bodySize: any = Buffer.byteLength(bodyStr, "utf8");

  // Size check
  if (bodySize > maxBodySize) {
    return {
      success: false,
      error: _buildError("body_too_large", `Request body exceeds ${maxBodySize} bytes.`, {
        bodySize,
        maxBodySize,
        contentType,
        traceId,
      }),
    };
  }

  // Empty body
  const trimmed: any = bodyStr.trim();
  if (trimmed.length === 0) {
    return {
      success: false,
      error: _buildError("empty_body", "Request body is empty after trimming.", {
        contentType,
        traceId,
      }),
    };
  }

  // Content type check (warn but don't reject non-JSON content types)
  if (contentType && !contentType.includes("json") && !contentType.includes("text/plain")) {
    // Continue but flag
  }

  // Parse
  try {
    const data: any = JSON.parse(trimmed);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return {
        success: false,
        error: _buildError("invalid_json", "Request body must be a JSON object.", {
          bodySize,
          contentType,
          traceId,
          bodyHash: canonicalHash(bodyStr),
        }),
      };
    }
    return { success: true, data };
  } catch (err: any) {
    const parseError: Record<string, any> = {
      message: _redactErrorMessage(err.message),
      position: _extractErrorPosition(err.message),
    };

    return {
      success: false,
      error: _buildError("invalid_json", "Request body is not valid JSON.", {
        bodySize,
        contentType,
        traceId,
        bodyHash: canonicalHash(bodyStr),
        parseError,
      }),
    };
  }
}

/**
 * Strict JSON body parser middleware for HTTP requests.
 * @param {object} req - HTTP request object
 * @param {Function} readBody - Function to read the raw body (returns Promise<string>)
 * @param {object} [options]
 * @returns {Promise<{ success: true, data: object } | { success: false, error: object }>}
 */
export async function strictJsonBodyMiddleware(req?: any, readBody?: any, options: Record<string, any> = {}) : Promise<any> {
  const contentType: any = String(
    req?.headers?.["content-type"] ||
      req?.headers?.["Content-Type"] ||
      "application/json"
  );

  try {
    const body: any = await readBody();
    return parseStrictJsonBody(body, {
      ...options,
      contentType,
      traceId: req?.traceId || options.traceId,
    });
  } catch (err: any) {
    return {
      success: false,
      error: _buildError("body_read_error", "Failed to read request body.", {
        contentType,
        traceId: req?.traceId || options.traceId || "",
        readError: _redactErrorMessage(err.message),
      }),
    };
  }
}

// --- Private ---

function _buildError(code?: any, message?: any, metadata: Record<string, any> = {}) : any {
  return {
    code,
    message,
    metadata: {
      bodySize: metadata.bodySize || 0,
      contentType: metadata.contentType || "",
      traceId: metadata.traceId || "",
      bodyHash: metadata.bodyHash || "",
      maxBodySize: metadata.maxBodySize || 0,
      parseError: metadata.parseError || null,
      readError: metadata.readError || null,
    },
    timestamp: new Date().toISOString(),
  };
}

function _redactErrorMessage(message?: any) : any {
  if (!message) return "";
  // Remove any inline file paths, line numbers, column numbers that could leak
  // server internals. Keep the error type indicator only.
  const cleaned: any = String(message)
    .replace(/at position \d+/g, "at position <N>")
    .replace(/line \d+/gi, "line <N>")
    .replace(/column \d+/gi, "column <N>")
    .replace(/\/[^\s,]+/g, "<path>")
    .slice(0, 256);
  return cleaned;
}

function _extractErrorPosition(message?: any) : any {
  const match: any = String(message || "").match(/position (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
