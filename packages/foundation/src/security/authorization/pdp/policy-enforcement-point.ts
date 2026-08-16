/**
 * Policy Enforcement Point (PEP) — Intercepts requests at boundaries and enforces
 * authorization decisions from the PDP.
 *
 * PEP locations:
 *  - Operation dispatcher (HTTP, RPC, CLI)
 *  - Tool gateway (MCP and tool execution)
 *  - Console route guard (UI access control)
 *
 * PEP is stateless — it calls PDP for decisions and enforces them.
 * PEP NEVER makes authorization decisions itself.
 *
 * @module foundation/security/authorization/pdp/policy-enforcement-point
 */

import { createAuthorizationEngine } from "../authorization-engine.ts";

export interface AuthorizationDecision extends Record<string, unknown> {
  allowed: boolean;
  effect: string;
  reasonCode?: string;
  redactedReason?: string;
  decisionId?: string;
  operationId?: string;
  inputHash?: string;
  traceId?: string;
  subject?: { subjectId?: string };
}

export interface AuthorizationEnginePort {
  evaluate(input: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface AuditStore { recordDecision(decision: AuthorizationDecision, context: Record<string, unknown>): Promise<unknown> | unknown }
export interface ApprovalReceipt { valid?: boolean }
export interface ApprovalReceiptStore {
  validateReceipt(input: Record<string, unknown>): Promise<ApprovalReceipt | null> | ApprovalReceipt | null;
}
export interface PolicyEnforcementPointOptions {
  authorizationEngine?: AuthorizationEnginePort;
  auditStore?: AuditStore | null;
  approvalReceiptStore?: ApprovalReceiptStore | null;
}
export interface PepRequest extends Record<string, unknown> {
  routeConfig?: { operation?: Record<string, unknown>; tool?: Record<string, unknown> | null };
  authorizationSubject?: Record<string, unknown>;
  resourceContext?: Record<string, unknown>;
  body?: Record<string, unknown>;
  context?: Record<string, unknown>;
  traceId?: string;
  authorizationDecision?: AuthorizationDecision;
  approvalReceipt?: ApprovalReceipt | null;
}
export interface PepResponse { status(code: number): { json(body: unknown): unknown } }
export interface EnforcementResult {
  allowed: boolean; decision: AuthorizationDecision;
  needsApproval: boolean; approvalReceipt: ApprovalReceipt | null;
}
export interface EnforceParams {
  operation?: Record<string, unknown> & {
    safety?: { risk?: unknown; requiresApproval?: unknown };
    risk?: unknown;
    requiresApproval?: unknown;
  };
  tool?: (Record<string, unknown> & {
    risk?: unknown; destructive?: unknown; requiresApproval?: unknown;
  }) | null;
  subject?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  input?: Record<string, unknown>;
  request?: PepRequest | null;
  context?: Record<string, unknown>;
  traceId?: string;
}

export interface PolicyEnforcementPoint {
  enforce(params?: EnforceParams): Promise<EnforcementResult>;
  httpMiddleware(req?: PepRequest, res?: PepResponse, next?: () => unknown): Promise<unknown>;
  authorizationEngine: AuthorizationEnginePort;
}

export interface ConsoleRouteGuardParams {
  requiredScopes?: readonly string[];
  requiredCapabilities?: readonly string[];
  subject?: Record<string, unknown>;
  request?: PepRequest | null;
}

export interface ConsoleRouteGuardResult {
  allowed: boolean;
  reason?: string;
  decision: AuthorizationDecision;
}

export interface ConsoleRouteGuard {
  guardRoute(params?: ConsoleRouteGuardParams): Promise<ConsoleRouteGuardResult>;
  pep: PolicyEnforcementPoint;
}

function authorizationDecision(value: unknown): AuthorizationDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Authorization engine returned an invalid decision.");
  }
  const decision = value as Record<string, unknown>;
  if (typeof decision.allowed !== "boolean" || typeof decision.effect !== "string") {
    throw new TypeError("Authorization engine returned an incomplete decision.");
  }
  return decision as AuthorizationDecision;
}

/**
 * Create a PEP instance for operation dispatch.
 * @param {object} options
 * @param {object} options.authorizationEngine - Canonical authorization engine instance
 * @param {object} [options.auditStore] - Store for recording enforcement events
 * @param {object} [options.approvalReceiptStore] - Store for approval receipts
 * @returns {object} PEP instance
 */
export function createPolicyEnforcementPoint(options: PolicyEnforcementPointOptions = {}): PolicyEnforcementPoint {
  const authorizationEngine: AuthorizationEnginePort = options.authorizationEngine || createAuthorizationEngine();
  const auditStore = options.auditStore || null;
  const approvalReceiptStore = options.approvalReceiptStore || null;

  /**
   * Enforce authorization on an operation request.
   *
   * @param {object} params
   * @param {object} params.operation - Operation definition
   * @param {object} [params.tool] - Tool definition (for tool execution)
   * @param {object} params.subject - Resolved subject from PIP
   * @param {object} params.resource - Resolved resource context
   * @param {object} [params.input] - Operation input
   * @param {object} [params.request] - HTTP request
   * @param {object} [params.context] - Additional context
   * @param {string} [params.traceId]
   * @returns {Promise<{ allowed: boolean, decision: object, needsApproval: boolean, approvalReceipt: object|null }>}
   */
  async function enforce(params: EnforceParams = {}): Promise<EnforcementResult> {
    const {
      operation = {},
      tool = null,
      subject = {},
      resource = {},
      input = {},
      request = null,
      context = {},
      traceId = "",
    } = params;

    const decision = authorizationDecision(await authorizationEngine.evaluate({
      operation,
      tool,
      subject,
      resource,
      input,
      request,
      context,
      traceId,
    }));

    // Check for existing approval receipt
    let approvalReceipt = null;
    if (isApprovalEffect(decision.effect) && approvalReceiptStore) {
      approvalReceipt = await _checkApprovalReceipt(decision, input, context);
      if (approvalReceipt?.valid) {
        decision.effect = "allow";
        decision.allowed = true;
        decision.reasonCode = "approval_receipt_valid";
        decision.redactedReason = "Approval receipt validated.";
      }
    }

    // High-risk operations require an approval receipt, not just confirm:true
    const operationRisk = String(tool?.risk || operation?.safety?.risk || operation?.risk || "");
    const isHighRisk =
      (operationRisk === "destructive" || tool?.destructive || tool?.requiresApproval || operation?.requiresApproval === true || operation?.safety?.requiresApproval === true) &&
      decision.effect === "allow" &&
      decision.reasonCode !== "approval_receipt_valid";

    if (isHighRisk) {
      const hasReceipt = await _checkApprovalReceipt(decision, input, context);
      if (!hasReceipt?.valid) {
        decision.effect = "require_approval";
        decision.allowed = false;
        decision.reasonCode = "approval_receipt_required";
        decision.redactedReason =
          "High-risk operation requires an approval receipt (confirm:true is insufficient).";
      }
    }

    await _audit(decision, context);

    return {
      allowed: decision.allowed,
      decision,
      needsApproval: isApprovalEffect(decision.effect),
      approvalReceipt,
    };
  }

  /**
   * Enforce authorization as middleware for HTTP requests.
   * @param {object} req - HTTP request
   * @param {object} res - HTTP response
   * @param {Function} next - Next handler
   * @returns {Promise<void>}
   */
  async function httpMiddleware(
    req: PepRequest = {},
    res?: PepResponse,
    next?: () => unknown
  ): Promise<unknown> {
    const result = await enforce({
      operation: req.routeConfig?.operation || {},
      tool: req.routeConfig?.tool || null,
      subject: req.authorizationSubject || {},
      resource: req.resourceContext || {},
      input: req.body || {},
      request: req,
      context: req.context || {},
      traceId: req.traceId || "",
    });

    if (!result.allowed) {
      const statusCode = _effectToStatusCode(result.decision.effect);
      const errorBody = _buildErrorEnvelope(req, result.decision);

      if (res && typeof res.status === "function") {
        return res.status(statusCode).json(errorBody);
      }
      const err: Error & { statusCode?: number; decision?: AuthorizationDecision } = new Error(errorBody.error.message);
      err.statusCode = statusCode;
      err.decision = result.decision;
      throw err;
    }

    req.authorizationDecision = result.decision;
    req.approvalReceipt = result.approvalReceipt;

    if (typeof next === "function") {
      return next();
    }
  }

  // --- Private ---

  async function _audit(
    decision: AuthorizationDecision,
    context: Record<string, unknown>
  ): Promise<void> {
    if (auditStore && typeof auditStore.recordDecision === "function") {
      try {
        await auditStore.recordDecision(decision, context);
      } catch {
        // Audit failure should not block the request
      }
    }
  }

  async function _checkApprovalReceipt(
    decision: AuthorizationDecision,
    _input: Record<string, unknown>,
    _context: Record<string, unknown>
  ): Promise<ApprovalReceipt | null> {
    if (!approvalReceiptStore || typeof approvalReceiptStore.validateReceipt !== "function") {
      return null;
    }
    try {
      return await approvalReceiptStore.validateReceipt({
        decisionId: decision.decisionId,
        operationId: decision.operationId,
        subjectId: decision.subject?.subjectId,
        inputHash: decision.inputHash,
      });
    } catch {
      return null;
    }
  }

  function _effectToStatusCode(effect?: unknown): number {
    switch (effect) {
      case "deny":
        return 403;
      case "require_approval":
      case "needsApproval":
        return 403;
      case "require_confirmation":
        return 412; // Precondition Failed
      default:
        return 403;
    }
  }

  function _buildErrorEnvelope(req: PepRequest, decision: AuthorizationDecision) {
    // External callers must NOT see internal operationId
    const isExternalCaller = !req?.authorizationSubject ||
      req.authorizationSubject.type === "anonymous";

    return {
      error: {
        code: decision.reasonCode || "forbidden",
        message: isExternalCaller
          ? "Access denied."
          : decision.redactedReason || "Access denied.",
        // operationId omitted for unauthenticated/unauthorized callers
        ...(isExternalCaller ? {} : { operationId: decision.operationId }),
        decisionId: decision.decisionId,
        traceId: decision.traceId || "",
      },
    };
  }

  return {
    enforce,
    httpMiddleware,
    authorizationEngine,
  };
}

function isApprovalEffect(effect: unknown = ""): boolean {
  return effect === "require_approval" || effect === "needsApproval";
}

/**
 * Create a console route guard PEP.
 * @param {object} options
 * @returns {object}
 */
export function createConsoleRouteGuard(options: PolicyEnforcementPointOptions = {}): ConsoleRouteGuard {
  const pep = createPolicyEnforcementPoint(options);

  /**
   * Guard a console route by required scopes/capabilities.
   * @param {object} params
   * @param {string[]} params.requiredScopes
   * @param {string[]} params.requiredCapabilities
   * @param {object} params.subject
   * @param {object} params.request
   * @returns {Promise<{ allowed: boolean, reason: string }>}
   */
  async function guardRoute({
    requiredScopes = [],
    requiredCapabilities = [],
    subject = {},
    request = null
  }: ConsoleRouteGuardParams = {}): Promise<ConsoleRouteGuardResult> {
    const result = await pep.enforce({
      operation: {
        id: "console.route_guard",
        requiredScopes,
        readOnly: true,
      },
      subject,
      resource: {},
      request,
      context: { requiredCapabilities },
    });

    return {
      allowed: result.allowed,
      reason: result.decision.redactedReason,
      decision: result.decision,
    };
  }

  return {
    guardRoute,
    pep,
  };
}
