import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";

import {
  CONSOLE_COMPOSITION_FORBIDDEN_PATTERNS,
  CONSOLE_COMPOSITION_REQUIRED_TOKENS,
  CONSOLE_COMPOSITION_SOURCE_PATH
} from "./console-administration-composition-contract.ts";

const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

export function operationMap(operations: any = SERVER_API_OPERATIONS) : any {
  return new Map<any, any>(operations.map((operation?: any) : any => [operation.id, operation]));
}

function endpointRegex(apiPath: any = "") : any {
  const parameterized: any = String(apiPath || "").replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "__PATH_PARAM__");
  const escaped: any = parameterized
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/__PATH_PARAM__/gu, "[^\"'`\\s]+");
  return new RegExp(escaped, "u");
}

function methodRegex(operation: Record<string, any> = {}) : any {
  const method: any = String(operation.http?.method || "GET").toUpperCase();
  const apiPath: any = String(operation.http?.path || "");
  if (!apiPath) {
    return null;
  }
  const pathPattern: any = endpointRegex(apiPath).source;
  if (method === "GET") {
    return new RegExp(`(?:getJson|downloadFile|method:\\s*["']GET["'])[\\s\\S]{0,240}${pathPattern}|${pathPattern}[\\s\\S]{0,240}method:\\s*["']GET["']`, "u");
  }
  if (method === "POST") {
    return new RegExp(`(?:postJson|method:\\s*["']POST["'])[\\s\\S]{0,240}${pathPattern}|${pathPattern}[\\s\\S]{0,240}method:\\s*["']POST["']`, "u");
  }
  return new RegExp(`${pathPattern}[\\s\\S]{0,240}method:\\s*["']${method}["']`, "u");
}

export function sourceEvidence(operation?: any, sourceText: any = "") : any {
  const operationId: any = String(operation?.id || "");
  const hasOperationId: any = sourceText.includes(`"${operationId}"`) ||
    sourceText.includes(`'${operationId}'`) ||
    sourceText.includes(operationId);
  const hasEndpoint: any = operation?.http?.path ? endpointRegex(operation.http.path).test(sourceText) : false;
  const hasMethodEndpoint: any = operation?.http?.path ? methodRegex(operation)?.test(sourceText) === true : false;
  return {
    hasOperationId,
    hasEndpoint,
    hasMethodEndpoint,
    ok: hasOperationId || hasEndpoint
  };
}

export function assertNoReportLeak(report?: any) : any {
  const text: any = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Console administration coverage report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

export function inspectConsoleComposition(sourceText?: any) : any {
  const requiredTokens: any = CONSOLE_COMPOSITION_REQUIRED_TOKENS.map((token?: any) : any => ({
    token,
    present: token.startsWith("createConsole")
      ? new RegExp(`\\b${token}\\s*\\(`, "u").test(sourceText)
      : token === "firstAccessibleRoutePath"
        ? /\bfunction\s+firstAccessibleRoutePath\s*\(/u.test(sourceText)
        : /\breturn\s+controller\s+satisfies\s+ConsoleController\b/u.test(sourceText)
  }));
  const forbiddenPatterns: any = CONSOLE_COMPOSITION_FORBIDDEN_PATTERNS.map((entry?: any) : any => ({
    id: entry.id,
    label: entry.label,
    present: entry.pattern.test(sourceText)
  }));
  const findings: any[] = [
    ...requiredTokens.filter((entry?: any) : any => !entry.present).map((entry?: any) : any => `missing:${entry.token}`),
    ...forbiddenPatterns.filter((entry?: any) : any => entry.present).map((entry?: any) : any => `forbidden:${entry.label}`)
  ];
  return {
    sourceFile: CONSOLE_COMPOSITION_SOURCE_PATH,
    requiredTokens,
    forbiddenPatterns,
    findings,
    compositionReady: findings.length === 0
  };
}
