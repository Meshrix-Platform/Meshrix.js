import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";

import {
  CONSOLE_COMPOSITION_FORBIDDEN_PATTERNS,
  CONSOLE_COMPOSITION_REQUIRED_TOKENS,
  CONSOLE_COMPOSITION_SOURCE_PATH
} from "./console-administration-composition-contract.mjs";

const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

export function operationMap(operations = SERVER_API_OPERATIONS) {
  return new Map(operations.map((operation) => [operation.id, operation]));
}

function endpointRegex(apiPath = "") {
  const parameterized = String(apiPath || "").replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "__PATH_PARAM__");
  const escaped = parameterized
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/__PATH_PARAM__/gu, "[^\"'`\\s]+");
  return new RegExp(escaped, "u");
}

function methodRegex(operation = {}) {
  const method = String(operation.http?.method || "GET").toUpperCase();
  const apiPath = String(operation.http?.path || "");
  if (!apiPath) {
    return null;
  }
  const pathPattern = endpointRegex(apiPath).source;
  if (method === "GET") {
    return new RegExp(`(?:getJson|downloadFile|method:\\s*["']GET["'])[\\s\\S]{0,240}${pathPattern}|${pathPattern}[\\s\\S]{0,240}method:\\s*["']GET["']`, "u");
  }
  if (method === "POST") {
    return new RegExp(`(?:postJson|method:\\s*["']POST["'])[\\s\\S]{0,240}${pathPattern}|${pathPattern}[\\s\\S]{0,240}method:\\s*["']POST["']`, "u");
  }
  return new RegExp(`${pathPattern}[\\s\\S]{0,240}method:\\s*["']${method}["']`, "u");
}

export function sourceEvidence(operation, sourceText = "") {
  const operationId = String(operation?.id || "");
  const hasOperationId = sourceText.includes(`"${operationId}"`) ||
    sourceText.includes(`'${operationId}'`) ||
    sourceText.includes(operationId);
  const hasEndpoint = operation?.http?.path ? endpointRegex(operation.http.path).test(sourceText) : false;
  const hasMethodEndpoint = operation?.http?.path ? methodRegex(operation)?.test(sourceText) === true : false;
  return {
    hasOperationId,
    hasEndpoint,
    hasMethodEndpoint,
    ok: hasOperationId || hasEndpoint
  };
}

export function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Console administration coverage report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

export function inspectConsoleComposition(sourceText) {
  const requiredTokens = CONSOLE_COMPOSITION_REQUIRED_TOKENS.map((token) => ({
    token,
    present: token.startsWith("createConsole")
      ? new RegExp(`\\b${token}\\s*\\(`, "u").test(sourceText)
      : token === "firstAccessibleRoutePath"
        ? /\bfunction\s+firstAccessibleRoutePath\s*\(/u.test(sourceText)
        : /\breturn\s+controller\s+satisfies\s+ConsoleController\b/u.test(sourceText)
  }));
  const forbiddenPatterns = CONSOLE_COMPOSITION_FORBIDDEN_PATTERNS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    present: entry.pattern.test(sourceText)
  }));
  const findings = [
    ...requiredTokens.filter((entry) => !entry.present).map((entry) => `missing:${entry.token}`),
    ...forbiddenPatterns.filter((entry) => entry.present).map((entry) => `forbidden:${entry.label}`)
  ];
  return {
    sourceFile: CONSOLE_COMPOSITION_SOURCE_PATH,
    requiredTokens,
    forbiddenPatterns,
    findings,
    compositionReady: findings.length === 0
  };
}
