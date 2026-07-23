import crypto from "node:crypto";
import { evaluateOperationSafety } from "#lico/contracts/operations/operation-decorators";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#lico/foundation/observability/runtime-logger";
import { childTraceContext, getTraceContext, runWithTraceContext,
  setTraceContextOnRequest, traceContextFromRequest } from "#lico/foundation/observability/trace-context";
import { createAuthorizationEngine } from "#lico/foundation/security/authorization/authorization-engine";
import { verifyExternalAuth } from "./dispatch-operation-auth.mjs";
import {
  actorFromInput,
  externalAuthDeniedPayload,
  externalAuthVerifierConfig,
  firstText,
  logOperation,
  notifyNarrowTransition,
  notifySideEffectStart,
  operationEventName,
  requestIdFromRequest,
  sendOperationDenied
} from "./dispatch-operation-support.mjs";
import {
  applyCoercion,
  inputFromRequest,
  invokeRegisteredOperation,
  validateInputSchema
} from "./dispatch-operation-input.mjs";
import { withOperationLock } from "./operation-dispatch-lock.mjs";
import { createDispatchProofLifecycle } from "./dispatch-operation-proof-lifecycle.mjs";
import {
  DISPATCHER_RISK_CONTROL_IDS,
  appendDispatcherRiskGate,
  auditOperation,
  auditOperationDisposition,
  createDispatcherRiskControlEnvelope
} from "./dispatch-operation-risk-control.mjs";

const dispatcherAuthorizationEngine = createAuthorizationEngine();

export async function dispatchOperation({
  operation,
  controllers,
  request,
  response,
  requestBody = Buffer.alloc(0),
  url = new URL("/", "http://127.0.0.1"),
  params = {},
  input = null,
  transport = "internal",
  method = operation?.http?.method || "POST",
  applyHttpQuery = true,
  authorizeOperation = null,
  verifyProcessIdentity = null,
  operationAuditStore = null,
  operationProofSubstrate = null,
  lockManager = null,
  concurrencyScope = "default",
  signal = null,
  logger = getRuntimeLogger(),
  authSession: providedAuthSession = null,
  actor: providedActor = null,
  skipAuthorization = false
} = {}) {
  if (!operation) {
    throw new Error("dispatchOperation requires an operation.");
  }
  const parentTrace = traceContextFromRequest(request) || getTraceContext();
  let actor = actorFromInput({ actor: providedActor, authSession: providedAuthSession });
  const traceContext = childTraceContext({
    parent: parentTrace,
    transport,
    operationId: operation.id,
    actor
  });
  setTraceContextOnRequest(request, traceContext);

  return runWithTraceContext(traceContext, async () => {
    const suppliedOperationInput = input ?? inputFromRequest({
        operation,
        requestBody,
        url,
        params,
        applyHttpQuery
      });
    const operationInput =
      suppliedOperationInput &&
      typeof suppliedOperationInput === "object" &&
      !Array.isArray(suppliedOperationInput)
        ? { ...suppliedOperationInput }
        : suppliedOperationInput;
    if (
      operationInput &&
      typeof operationInput === "object" &&
      !Array.isArray(operationInput)
    ) {
      applyCoercion(operation, operationInput);
    }
    let authSession = providedAuthSession;
    const riskControlEnvelope = createDispatcherRiskControlEnvelope({
      request,
      operation,
      traceContext,
      transport,
      method,
      input: operationInput
    });
    const appendRiskGate = (gate = {}) => appendDispatcherRiskGate({
      envelope: riskControlEnvelope,
      request,
      operation,
      actor: gate.actor === undefined ? actor : gate.actor,
      authSession: gate.authSession === undefined ? authSession : gate.authSession,
      traceContext,
      transport,
      method,
      url,
      ...gate
    });
    const writeAuditOperation = (entry = {}) => {
      const auditDisposition = auditOperationDisposition({
        operationAuditStore: entry.operationAuditStore,
        operation: entry.operation || operation,
        status: entry.status
      });
      const auditRecord = auditOperation({
        ...entry,
        riskControlEnvelope
      });
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.auditRecover,
        decision: "allow",
        reasonCode: auditDisposition === "recorded"
          ? "audit_operation_recorded"
          : auditDisposition === "suppressed"
            ? "audit_success_suppressed"
            : "audit_disabled",
        statusCode: entry.statusCode || 0,
        details: {
          auditDisposition,
          auditStatus: entry.status || "",
          hasError: Boolean(entry.error)
        }
      });
      return auditRecord;
    };
    const {
      ensureProofLifecycleStarted,
      finishProofWithAudit
    } = createDispatchProofLifecycle({
      operationProofSubstrate,
      operation,
      operationInput,
      transport,
      method,
      url,
      request,
      response,
      traceContext,
      riskControlEnvelope,
      getActor: () => actor,
      getAuthSession: () => authSession,
      writeAuditOperation
    });
    const startedAt = Date.now();
    notifyNarrowTransition(request, "operation.normalize", "normalized");

    logOperation(logger, "debug", operationEventName(transport, "matched"), {
      requestId: requestIdFromRequest(request),
      operationId: operation.id,
      method,
      route: url?.pathname || "",
      transport,
      risk: operation.safety?.risk || "",
      readOnly: operation.readOnly === true,
      requestBodyBytes: requestBody?.length || 0,
      logRedaction: operation.log?.redaction || "default",
      input: operation.log?.recordInput === false
        ? { redacted: true, reason: "operation-log-policy" }
        : summarizeForLog(operationInput, { maxDepth: 4, maxArrayItems: 8, maxObjectKeys: 50 })
    });

    const schema = validateInputSchema(operation, operationInput);
    if (!schema.ok) {
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.admit,
        decision: "deny",
        reasonCode: "schema_invalid",
        statusCode: schema.status || 400,
        details: {
          error: schema.error
        }
      });
      await finishProofWithAudit({
        operationAuditStore,
        operation,
        transport,
        actor,
        input: operationInput,
        status: "denied",
        statusCode: schema.status || 400,
        error: schema.error
      });
      logOperation(logger, "warn", operationEventName(transport, "denied"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        reason: "schema",
        error: schema.error,
        status: schema.status || 400
      });
      const declaredSchemaError = operation.http?.schemaError;
      sendOperationDenied(
        response,
        schema.status || declaredSchemaError?.status || 400,
        declaredSchemaError?.code
          ? {
              ...(declaredSchemaError.responseBase || {}),
              code: declaredSchemaError.code,
              error: schema.error
            }
          : {
              error: schema.error,
              operationId: operation.id,
              traceId: traceContext.traceId
            }
      );
      notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
      return {
        ok: false,
        handled: true,
        statusCode: schema.status || 400,
        operation,
        input: operationInput,
        traceContext,
        riskControl: riskControlEnvelope
      };
    }

    appendRiskGate({
      controlId: DISPATCHER_RISK_CONTROL_IDS.admit,
      decision: "allow",
      reasonCode: "schema_valid",
      details: {
        schema: "valid"
      }
    });
    const authEnabled = true;
    let processIdentityVerification = null;
    const processIdentityRequired = operation.processIdentity?.required === true;
    if (!skipAuthorization && processIdentityRequired) {
      processIdentityVerification = typeof verifyProcessIdentity === "function"
        ? await verifyProcessIdentity({
            operation,
            request,
            requestBody,
            url,
            method,
            transport,
            input: operationInput
          })
        : {
            ok: false,
            status: 503,
            reasonCode: "process_identity_verifier_missing",
            error: "Process identity verifier is not registered for this transport."
          };
      if (!processIdentityVerification.ok) {
        const status = Number(processIdentityVerification.status || processIdentityVerification.statusCode || 401) || 401;
        const error = processIdentityVerification.error || "process identity verification denied";
        appendRiskGate({
          controlId: DISPATCHER_RISK_CONTROL_IDS.externalBind,
          decision: "deny",
          reasonCode: processIdentityVerification.reasonCode || "process_identity_denied",
          statusCode: status,
          details: {
            requiredCapabilities: processIdentityVerification.requiredCapabilities || []
          }
        });
        await finishProofWithAudit({
          operationAuditStore,
          operation,
          transport,
          authSession,
          actor,
          input: operationInput,
          status: "denied",
          statusCode: status,
          error
        });
        logOperation(logger, "warn", operationEventName(transport, "denied"), {
          requestId: requestIdFromRequest(request),
          operationId: operation.id,
          reason: processIdentityVerification.reasonCode || "process_identity",
          status
        });
        sendOperationDenied(response, status, {
          error,
          traceId: traceContext.traceId
        });
        notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
        return { ok: false, handled: true, statusCode: status, operation, input: operationInput, traceContext, riskControl: riskControlEnvelope };
      }
      if (request && typeof request === "object") {
        request.__licoProcessIdentity = processIdentityVerification;
      }
      if (processIdentityVerification.authSession) {
        authSession = processIdentityVerification.authSession;
      }
      if (processIdentityVerification.actor) {
        actor = processIdentityVerification.actor;
      }
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.externalBind,
        decision: "allow",
        reasonCode: processIdentityVerification.reasonCode || "process_identity_verified",
        actor,
        authSession,
        details: {
          packageId: processIdentityVerification.client?.packageId || "",
          processKeyId: processIdentityVerification.client?.processKeyId || ""
        }
      });
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.platformAuthorize,
        decision: "allow",
        reasonCode: "process_identity_capability_authorized",
        actor,
        authSession,
        details: {
          requiredCapabilities: processIdentityVerification.requiredCapabilities || []
        }
      });
    }
    const processIdentityAuthorizes =
      processIdentityRequired &&
      processIdentityVerification?.ok === true &&
      operation.processIdentity?.authorizes === true;
    const shouldRunConsoleAuthorization =
      !processIdentityAuthorizes &&
      !skipAuthorization &&
      operation.externalAuth !== true &&
      typeof authorizeOperation === "function";

    if (!skipAuthorization && operation.externalAuth === true) {
      const verification = await verifyExternalAuth({
        operation,
        controllers,
        request,
        input: operationInput,
        requestBody,
        url,
        params,
        method,
        transport
	      });
	      if (!verification.ok) {
	        const status = Number(verification.status || verification.statusCode || 401) || 401;
	        const error = verification.error || verification.message || "external authentication denied";
	        appendRiskGate({
	          controlId: (verification.missingScopes || []).length > 0 || (verification.missingCapabilities || []).length > 0
	            ? DISPATCHER_RISK_CONTROL_IDS.externalAuthorize
	            : DISPATCHER_RISK_CONTROL_IDS.externalBind,
	          decision: "deny",
	          reasonCode: verification.reasonCode || verification.code || "external_auth_denied",
	          statusCode: status,
	          details: {
	            missingScopes: verification.missingScopes || [],
	            missingCapabilities: verification.missingCapabilities || []
	          }
	        });
	        await finishProofWithAudit({
	          operationAuditStore,
	          operation,
	          transport,
	          authSession,
	          actor,
	          input: operationInput,
	          status: "denied",
	          statusCode: status,
	          error
	        });
        logOperation(logger, "warn", operationEventName(transport, "denied"), {
          requestId: requestIdFromRequest(request),
          operationId: operation.id,
          reason: verification.reasonCode || verification.code || "external_auth",
          status
	        });
	        sendOperationDenied(response, status, externalAuthDeniedPayload(operation, verification, traceContext.traceId));
	        notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
	        return { ok: false, handled: true, statusCode: status, operation, input: operationInput, traceContext, riskControl: riskControlEnvelope };
	      }
	      if (request && typeof request === "object") {
	        request.__licoExternalAuth = verification;
	        const externalGrantRef = firstText(verification.grantRef, verification.grant?.id);
	        const externalDecisionRef = firstText(verification.authorizationDecision?.decisionId);
	        const externalPolicyRevision = verification.governancePolicyRevision || null;
	        if (externalGrantRef && externalDecisionRef && externalPolicyRevision?.revision) {
	          request.__licoOperationRuntimeAuthorization = Object.freeze({
	            ok: true,
	            grantRef: externalGrantRef,
	            grant: Object.freeze({
	              id: externalGrantRef,
	              scopes: Object.freeze([...(verification.actor?.scopes || [])]),
	              capabilities: Object.freeze([...(verification.actor?.capabilities || [])])
	            }),
	            policy: Object.freeze({
	              decisionId: externalDecisionRef,
	              governancePolicyRevision: externalPolicyRevision
	            })
	          });
	        }
	      }
	      if (verification.authSession) {
	        authSession = verification.authSession;
	      }
	      if (verification.actor) {
	        actor = verification.actor;
	      }
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.externalBind,
	        decision: "allow",
	        reasonCode: "external_auth_bound",
	        actor,
	        authSession,
	        details: {
	          verifier: externalAuthVerifierConfig(operation).method || "",
	          grantId: firstText(verification.grantId, verification.grant?.id, authSession?.user?.grantId, authSession?.user?.userId)
	        }
	      });
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.externalAuthorize,
	        decision: "allow",
	        reasonCode: "external_auth_authorized",
	        actor,
	        authSession,
	        details: {
	          authorizationDecisionId: verification.authorizationDecision?.decisionId || "",
	          scopes: authSession?.user?.scopes || []
	        }
	      });
	    }

    if (shouldRunConsoleAuthorization) {
      const authorization = await authorizeOperation({
        request,
        operation,
        method,
        url,
        input: operationInput
	      });
	      if (!authorization.ok) {
	        const authorizationSession = authorization.session || null;
	        if (authorizationSession) {
	          appendRiskGate({
	            controlId: DISPATCHER_RISK_CONTROL_IDS.consoleBind,
	            decision: "allow",
	            reasonCode: "console_session_bound",
	            authSession: authorizationSession,
	            details: {
	              publicAccess: operation.public === true
	            }
	          });
	        }
	        appendRiskGate({
	          controlId: authorizationSession
	            ? DISPATCHER_RISK_CONTROL_IDS.operationAuthorize
	            : DISPATCHER_RISK_CONTROL_IDS.consoleBind,
	          decision: "deny",
	          reasonCode: authorization.authorizationDecision?.reasonCode || "authorization_denied",
	          statusCode: authorization.status || 403,
	          authSession: authorizationSession,
	          details: {
	            authorizationDecisionId: authorization.authorizationDecision?.decisionId || "",
	            missingScopes: authorization.authorizationDecision?.missingScopes || [],
	            missingCapabilities: authorization.authorizationDecision?.missingCapabilities || []
	          }
	        });
	        await finishProofWithAudit({
	          operationAuditStore,
	          operation,
	          transport,
	          authSession: authorizationSession,
	          actor,
	          input: operationInput,
	          status: "denied",
	          statusCode: authorization.status || 403,
	          error: authorization.error || "authorization denied"
	        });
        logOperation(logger, "warn", operationEventName(transport, "denied"), {
          requestId: requestIdFromRequest(request),
          operationId: operation.id,
          reason: "authorization",
          error: authorization.error || "authorization denied",
          status: authorization.status || 403
        });
        // L-4: omit operationId from auth-denied responses to reduce information
        // disclosure to unauthenticated callers probing available endpoints
        sendOperationDenied(response, authorization.status || 403, {
          error: authorization.error || "权限不足。",
          bootstrap: authorization.bootstrap,
          traceId: traceContext.traceId
        });
        notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
        return {
          ok: false,
          handled: true,
          statusCode: authorization.status || 403,
	          operation,
	          input: operationInput,
	          traceContext,
	          riskControl: riskControlEnvelope
	        };
	      }
	      authSession = authorization.session || null;
	      actor = actorFromInput({ actor: providedActor, authSession });
        if (request && typeof request === "object") {
          const subjectRef = firstText(
            authSession?.user?.subjectId,
            authSession?.user?.userId,
            authSession?.user?.id
          );
          const sessionRef = firstText(authSession?.sessionId, authSession?.id, subjectRef);
          request.__licoOperationRuntimeAuthorization = Object.freeze({
            ok: authorization.authorizationDecision?.allowed === true,
            grantRef: sessionRef
              ? `console:${crypto.createHash("sha256").update(sessionRef).digest("hex").slice(0, 24)}`
              : "",
            subjectRef,
            policy: Object.freeze({
              decisionId: String(authorization.authorizationDecision?.decisionId || ""),
              governancePolicyRevision: authorization.governancePolicyRevision || null
            })
          });
        }
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.consoleBind,
	        decision: "allow",
	        reasonCode: authSession ? "console_session_bound" : "public_access_bound",
	        actor,
	        authSession,
	        details: {
	          publicAccess: operation.public === true,
	          setupMode: authorization.setupMode === true
	        }
	      });
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
	        decision: "allow",
	        reasonCode: authorization.authorizationDecision?.reasonCode || (operation.public === true ? "allowed_public" : "operation_authorized"),
	        actor,
	        authSession,
	        details: {
	          authorizationDecisionId: authorization.authorizationDecision?.decisionId || "",
	          requiredScopes: operation.requiredScopes || []
	        }
	      });
	    } else if (processIdentityAuthorizes) {
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
        decision: "allow",
        reasonCode: "process_identity_authorized",
        actor,
        authSession,
        details: {
          requiredCapabilities: processIdentityVerification?.requiredCapabilities || []
        }
      });
    } else if (skipAuthorization) {
      const approvedPendingOperation = request?.__licoToolRuntimeAuthorization?.approvedPendingOperation || null;
      const authorizationDecision = dispatcherAuthorizationEngine.evaluate({
        operation,
        request,
        actor: providedActor,
        authSession,
        input: operationInput,
        context: {
          transport,
          skipAuthorization: true,
          approvedPendingOperation
        },
        traceId: traceContext.traceId,
        enforceConfirmation: false
      });
	      if (!authorizationDecision.allowed) {
	        const missingScopes = authorizationDecision.missingScopes || [];
	        const error = missingScopes.length > 0
	          ? `Operation ${operation.id} requires scopes: ${missingScopes.join(", ")}.`
	          : `Operation ${operation.id} authorization denied: ${authorizationDecision.reasonCode}.`;
	        appendRiskGate({
	          controlId: DISPATCHER_RISK_CONTROL_IDS.platformAuthorize,
	          decision: "deny",
	          reasonCode: authorizationDecision.reasonCode || "authorization_denied",
	          statusCode: 403,
	          details: {
	            authorizationDecisionId: authorizationDecision.decisionId,
	            missingScopes,
	            missingCapabilities: authorizationDecision.missingCapabilities || []
	          }
	        });
	        await finishProofWithAudit({
	          operationAuditStore,
	          operation,
	          transport,
	          authSession,
	          actor,
	          input: operationInput,
	          status: "denied",
	          statusCode: 403,
	          error
	        });
        logOperation(logger, "warn", operationEventName(transport, "denied"), {
          requestId: requestIdFromRequest(request),
          operationId: operation.id,
          reason: authorizationDecision.reasonCode || "authorization",
          missingScopes,
          status: 403
        });
        sendOperationDenied(response, 403, {
          error,
          operationId: operation.id,
          traceId: traceContext.traceId,
          missingScopes,
          authorizationDecisionId: authorizationDecision.decisionId
        });
        notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
        return {
          ok: false,
          handled: true,
          statusCode: 403,
	          operation,
	          input: operationInput,
	          traceContext,
	          riskControl: riskControlEnvelope
	        };
	      }
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.platformAuthorize,
	        decision: "allow",
	        reasonCode: authorizationDecision.reasonCode || "preauthorized_dispatch_allowed",
	        details: {
	          authorizationDecisionId: authorizationDecision.decisionId,
	          skipAuthorization: true
	        }
	      });
	    } else if (operation.externalAuth !== true && operation.public !== true && ["http", "rpc"].includes(transport)) {
	      const error = "Operation authorizer is not registered for this transport.";
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
	        decision: "deny",
	        reasonCode: "operation_authorizer_missing",
	        statusCode: 503,
	        details: {
	          transport
	        }
	      });
	      await finishProofWithAudit({
	        operationAuditStore,
	        operation,
	        transport,
	        authSession,
	        actor,
	        input: operationInput,
	        status: "denied",
	        statusCode: 503,
	        error
	      });
	      logOperation(logger, "error", operationEventName(transport, "denied"), {
	        requestId: requestIdFromRequest(request),
	        operationId: operation.id,
	        reason: "operation_authorizer_missing",
	        status: 503
	      });
	      sendOperationDenied(response, 503, {
	        error: "操作授权器未注册。",
	        traceId: traceContext.traceId
	      });
	      notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
	      return {
	        ok: false,
	        handled: true,
	        statusCode: 503,
	        operation,
	        input: operationInput,
	        traceContext,
	        riskControl: riskControlEnvelope
	      };
	    } else if (operation.externalAuth !== true) {
	      appendRiskGate({
	        controlId: operation.public === true
	          ? DISPATCHER_RISK_CONTROL_IDS.operationAuthorize
	          : DISPATCHER_RISK_CONTROL_IDS.platformAuthorize,
	        decision: "allow",
	        reasonCode: operation.public === true ? "allowed_public_without_authorizer" : "internal_dispatch_authorized",
	        details: {
	          transport,
	          publicAccess: operation.public === true
	        }
	      });
	    }

    const safety = evaluateOperationSafety({
      operation,
      requestBody,
      url,
      params,
      request,
      authSession,
      authEnabled
	    });
	    if (!safety.ok) {
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.approve,
	        decision: "deny",
	        reasonCode: safety.safety?.blocked || safety.safety?.risk === "destructive"
	          ? "risk_blocked"
	          : "approval_denied",
	        statusCode: safety.status || 403,
	        details: {
	          risk: safety.safety?.risk || "",
	          approvalScope: safety.safety?.approvalScope || "",
	          requiresConfirmation: safety.safety?.requiresConfirmation === true
	        }
	      });
	      await finishProofWithAudit({
	        operationAuditStore,
	        operation,
	        transport,
	        authSession,
	        actor,
	        input: operationInput,
	        status: "denied",
	        statusCode: safety.status || 403,
	        error: safety.error || "operation safety denied"
	      });
      logOperation(logger, "warn", operationEventName(transport, "denied"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        reason: "safety",
        error: safety.error || "operation safety denied",
        status: safety.status || 403,
        safety: summarizeForLog(safety.safety || {})
      });
      sendOperationDenied(response, safety.status || 403, {
        error: safety.error || "操作被安全策略拒绝。",
        operationId: operation.id,
        traceId: traceContext.traceId,
        safety: {
          risk: safety.safety?.risk,
          approvalScope: safety.safety?.approvalScope,
          requiresConfirmation: safety.safety?.requiresConfirmation
        }
      });
      notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
      return {
        ok: false,
        handled: true,
        statusCode: safety.status || 403,
	        operation,
	        input: operationInput,
	        traceContext,
	        riskControl: riskControlEnvelope
	      };
	    }

	    appendRiskGate({
	      controlId: DISPATCHER_RISK_CONTROL_IDS.approve,
	      decision: "allow",
	      reasonCode: safety.safety?.requiresConfirmation ? "approval_confirmed" : "approval_not_required",
	      details: {
	        risk: safety.safety?.risk || "",
	        approvalScope: safety.safety?.approvalScope || "",
	        requiresConfirmation: safety.safety?.requiresConfirmation === true
	      }
	    });

	    notifyNarrowTransition(request, "operation.policy_allow", "policy_checked");
    await ensureProofLifecycleStarted({ reasonCode: "policy_allowed" });
    const governanceReceipt = Object.freeze({
      operationId: operation.id,
      authorized: true,
      approved: safety.safety?.requiresConfirmation !== true || safety.ok === true,
      receiptDigest: crypto.createHash("sha256").update(JSON.stringify({
        operationId: operation.id,
        traceId: traceContext.traceId,
        riskControlAnchor: riskControlEnvelope.anchorDigest || "",
        riskControlLastRecord: riskControlEnvelope.lastRecordDigest || "",
        approvalScope: safety.safety?.approvalScope || ""
      })).digest("hex")
    });

    try {
      logOperation(logger, "debug", operationEventName(transport, "started"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        concurrencySafe: operation.concurrencySafe === true,
        concurrencyGroup: operation.concurrencyGroup || operation.id
      });
      await withOperationLock({
        operation,
        lockManager,
        concurrencyScope,
        signal,
        run: (operationLock) => {
		          notifyNarrowTransition(request, "operation.execute_start", "executing");
	          notifySideEffectStart(request);
	          appendRiskGate({
	            controlId: DISPATCHER_RISK_CONTROL_IDS.execute,
	            decision: "allow",
	            reasonCode: "execute_started",
	            details: {
	              concurrencySafe: operation.concurrencySafe === true,
	              concurrencyGroup: operation.concurrencyGroup || operation.id
	            }
	          });
	          return invokeRegisteredOperation({
	            operation,
	            controllers,
            request,
            response,
            requestBody,
	            url,
	            params,
	            input: operationInput,
	            applyHttpQuery,
	            authSession,
            operationLock,
	            signal: operationLock?.signal || signal,
              governanceReceipt
	          });
	        }
	      });
	      const statusCode = response?.statusCode || 200;
	      await finishProofWithAudit({
	        operationAuditStore,
	        operation,
	        transport,
	        authSession,
	        actor,
	        input: operationInput,
	        status: statusCode >= 400 ? "failed" : "ok",
	        statusCode,
	        startedAt
	      });
      logOperation(logger, statusCode >= 400 ? "warn" : "debug", operationEventName(transport, "completed"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        statusCode,
        status: statusCode >= 400 ? "failed" : "ok",
        durationMs: Date.now() - startedAt
      });
      if (statusCode >= 400) {
        notifyNarrowTransition(request, "operation.fail", "failed");
      } else {
        notifyNarrowTransition(request, "operation.audit_record", "audit_recorded");
        notifyNarrowTransition(request, "operation.complete", "completed");
      }
      return {
        ok: statusCode < 400,
        handled: true,
        statusCode,
        operation,
	        input: operationInput,
	        authSession,
	        traceContext,
	        riskControl: riskControlEnvelope
	      };
	    } catch (error) {
	      await finishProofWithAudit({
	        operationAuditStore,
	        operation,
	        transport,
        authSession,
        actor,
	        input: operationInput,
	        status: "failed",
	        statusCode: response?.statusCode || 500,
	        startedAt,
	        error: error instanceof Error ? error.message : "operation failed"
	      });
      logOperation(logger, "error", operationEventName(transport, "failed"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        durationMs: Date.now() - startedAt,
        error: summarizeError(error)
      });
      notifyNarrowTransition(request, "operation.fail", "failed");
      throw error;
    }
  });
}
