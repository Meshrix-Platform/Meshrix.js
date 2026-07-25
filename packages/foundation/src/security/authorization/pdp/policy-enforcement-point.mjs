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

import { createAuthorizationEngine } from "../authorization-engine.mjs";

/**
 * Create a PEP instance for operation dispatch.
 * @param {object} options
 * @param {object} options.authorizationEngine - Canonical authorization engine instance
 * @param {object} [options.auditStore] - Store for recording enforcement events
 * @param {object} [options.approvalReceiptStore] - Store for approval receipts
 * @returns {object} PEP instance
 */
export function createPolicyEnforcementPoint(options = {}) {
  const authorizationEngine = options.authorizationEngine || createAuthorizationEngine();
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
  async function enforce(params = {}) {
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

    const decision = authorizationEngine.evaluate({
      operation,
      tool,
      subject,
      resource,
      input,
      request,
      context,
      traceId,
    });

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
  async function httpMiddleware(req, res, next) {
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
      const err = new Error(errorBody.message);
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

  async function _audit(decision, context) {
    if (auditStore && typeof auditStore.recordDecision === "function") {
      try {
        await auditStore.recordDecision(decision, context);
      } catch (_) {
        // Audit failure should not block the request
      }
    }
  }

  async function _checkApprovalReceipt(decision, input, context) {
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
    } catch (_) {
      return null;
    }
  }

  function _effectToStatusCode(effect) {
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

  function _buildErrorEnvelope(req, decision) {
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

function isApprovalEffect(effect = "") {
  return effect === "require_approval" || effect === "needsApproval";
}

/**
 * Create a console route guard PEP.
 * @param {object} options
 * @returns {object}
 */
export function createConsoleRouteGuard(options = {}) {
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
  async function guardRoute({ requiredScopes = [], requiredCapabilities = [], subject = {}, request = null } = {}) {
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
