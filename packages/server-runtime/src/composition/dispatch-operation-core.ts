import crypto from "node:crypto";
import { evaluateOperationSafety } from "#meshrix/contracts/operations/operation-decorators";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#meshrix/foundation/observability/runtime-logger";
import { childTraceContext, getTraceContext, runWithTraceContext,
  setTraceContextOnRequest, traceContextFromRequest } from "#meshrix/foundation/observability/trace-context";
import { createAuthorizationEngine } from "#meshrix/foundation/security/authorization/authorization-engine";
import {
  digestGovernedExecutionRequest
} from "#meshrix/foundation/security/governed-execution-permit-authority";
import {
  createFinalProtectedSinkAttempt,
  digestFinalProtectedSinkInput
} from "#meshrix/foundation/security/final-protected-sink-permit";
import { verifyExternalAuth } from "./dispatch-operation-auth.ts";
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
} from "./dispatch-operation-support.ts";
import {
  applyCoercion,
  inputFromRequest,
  invokeRegisteredOperation,
  validateInputSchema
} from "./dispatch-operation-input.ts";
import { withOperationLock } from "./operation-dispatch-lock.ts";
import { createDispatchProofLifecycle } from "./dispatch-operation-proof-lifecycle.ts";
import {
  DISPATCHER_RISK_CONTROL_IDS,
  appendDispatcherRiskGate,
  auditOperation,
  auditOperationDisposition,
  createDispatcherRiskControlEnvelope
} from "./dispatch-operation-risk-control.ts";

const dispatcherAuthorizationEngine: any = createAuthorizationEngine();

function requiresExecutionAuthorizationRevalidation(operation: Record<string, any> = {}) : any {
  return operation.public !== true || operation.readOnly !== true;
}

function executionAuthorizationDenied(decision: Record<string, any> = {}) : any {
  return Object.freeze({
    authorizationDenied: true,
    statusCode: Number(decision.status || decision.statusCode || 403) || 403,
    reasonCode: String(
      decision.reasonCode ||
      decision.authorizationDecision?.reasonCode ||
      "execution_authorization_denied"
    ),
    error: String(decision.error || "Execution authorization denied."),
    authorizationDecision: decision.authorizationDecision || null
  });
}

function finalProtectedSinkTargetSelector(operation: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  const operationId: any = String(operation.id || "").trim();
  if (operationId === "gateway.forward") {
    return Object.freeze({
      inputDigest: digestFinalProtectedSinkInput(input),
      operationKey: firstText(input?.operationKey),
      serviceId: firstText(
        input?.serviceId,
        input?.["service-id"],
        input?.upstreamId,
        input?.["upstream-id"]
      )
    });
  }
  if (operationId.startsWith("upstream_operation.")) {
    return Object.freeze({
      inputDigest: digestFinalProtectedSinkInput(input),
      operationKey: firstText(operation?._meta?.operationKey),
      serviceId: firstText(operation?._meta?.serviceId)
    });
  }
  return null;
}

function operationConcurrencyContract(operation: Record<string, any> = {}) : any {
  if (operation?._meta?.upstreamProjectedOperation === true) {
    return Object.freeze({
      ...operation,
      concurrency: Object.freeze({
        workloadClass: "parallel",
        key: "gateway.forward",
        maxParallel: 16,
        cost: 2
      })
    });
  }
  return operation;
}

const FINAL_PROTECTED_SINK_AUTHORITY_KEYS: readonly any[] = Object.freeze([
  "context",
  "subject"
]);
const FINAL_PROTECTED_SINK_SUBJECT_KEYS: readonly any[] = Object.freeze([
  "generation",
  "subjectId",
  "tenantId",
  "type"
]);
const FINAL_PROTECTED_SINK_CONTEXT_KEYS: readonly any[] = Object.freeze([
  "approvalRevision",
  "grantRevision",
  "policyRevision",
  "riskRevision",
  "workloadGeneration"
]);

function exactAuthorityRecord(value?: any, keys?: any) : any {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\u0000") ===
      [...keys].sort().join("\u0000") &&
    keys.every(
      (key?: any) : any =>
        typeof value[key] === "string" &&
        value[key].trim().length > 0
    )
  );
}

function protectedSinkAuthorityFacts(authorization: Record<string, any> = {}) : any {
  const explicit: any = authorization?.protectedSinkAuthority;
  if (
    !explicit ||
    typeof explicit !== "object" ||
    Array.isArray(explicit) ||
    Object.keys(explicit).sort().join("\u0000") !==
      [...FINAL_PROTECTED_SINK_AUTHORITY_KEYS].sort().join("\u0000") ||
    !exactAuthorityRecord(
      explicit.subject,
      FINAL_PROTECTED_SINK_SUBJECT_KEYS
    ) ||
    !exactAuthorityRecord(
      explicit.context,
      FINAL_PROTECTED_SINK_CONTEXT_KEYS
    )
  ) {
    return null;
  }
  return Object.freeze({
    subject: Object.freeze({
      generation: explicit.subject.generation.trim(),
      subjectId: explicit.subject.subjectId.trim(),
      tenantId: explicit.subject.tenantId.trim(),
      type: explicit.subject.type.trim()
    }),
    context: Object.freeze({
      approvalRevision: explicit.context.approvalRevision.trim(),
      grantRevision: explicit.context.grantRevision.trim(),
      policyRevision: explicit.context.policyRevision.trim(),
      riskRevision: explicit.context.riskRevision.trim(),
      workloadGeneration: explicit.context.workloadGeneration.trim()
    })
  });
}

function protectedSinkAuthoritiesCanonicalEqual(left?: any, right?: any) : any {
  if (!left || !right) return false;
  return FINAL_PROTECTED_SINK_SUBJECT_KEYS.every(
    (key?: any) : any => left.subject[key] === right.subject[key]
  ) && FINAL_PROTECTED_SINK_CONTEXT_KEYS.every(
    (key?: any) : any => left.context[key] === right.context[key]
  );
}

function finalAuthorityRevoked(authorization: Record<string, any> = {}) : any {
  return authorization.revoked === true ||
    /revok/iu.test(String(
      authorization.reasonCode ||
      authorization.authorizationDecision?.reasonCode ||
      ""
    ));
}

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
  revalidateAuthorization = null,
  resolveAuthorizationOperation = null,
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
}: Record<string, any> = {}) : Promise<any> {
  if (!operation) {
    throw new Error("dispatchOperation requires an operation.");
  }
  const parentTrace: any = traceContextFromRequest(request) || getTraceContext();
  let actor: any = actorFromInput({ actor: providedActor, authSession: providedAuthSession });
  const traceContext: any = childTraceContext({
    parent: parentTrace,
    transport,
    operationId: operation.id,
    actor
  });
  setTraceContextOnRequest(request, traceContext);

  return runWithTraceContext(traceContext, async () : Promise<any> => {
    const suppliedOperationInput: any = input ?? inputFromRequest({
        operation,
        requestBody,
        url,
        params,
        applyHttpQuery
      });
    const operationInput: any =
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
    let authSession: any = providedAuthSession;
    const riskControlEnvelope: any = createDispatcherRiskControlEnvelope({
      request,
      operation,
      traceContext,
      transport,
      method,
      input: operationInput
    });
    const appendRiskGate: any = (gate: Record<string, any> = {}) : any => appendDispatcherRiskGate({
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
    const writeAuditOperation: any = (entry: Record<string, any> = {}) : any => {
      const auditDisposition: any = auditOperationDisposition({
        operationAuditStore: entry.operationAuditStore,
        operation: entry.operation || operation,
        status: entry.status
      });
      const auditRecord: any = auditOperation({
        ...entry,
        authorizationDecisionId:
          entry.authorizationDecisionId ||
          request?.__meshrixOperationRuntimeAuthorization?.policy?.decisionId ||
          "",
        proofId: entry.proofId || request?.__meshrixOperationProof?.ledgerEventId || "",
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
      getActor: () : any => actor,
      getAuthSession: () : any => authSession,
      writeAuditOperation
    });
    const startedAt: any = Date.now();
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

    const schema: any = validateInputSchema(operation, operationInput);
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
      const declaredSchemaError: any = operation.http?.schemaError;
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
    const admissionTargetSelector: any = finalProtectedSinkTargetSelector(
      operation,
      operationInput
    );
    const authorizationOperationForPhase: any = (phase?: any) : any => {
      if (
        !admissionTargetSelector ||
        typeof resolveAuthorizationOperation !== "function"
      ) {
        return operation;
      }
      try {
        const currentOperation: any = resolveAuthorizationOperation({
          operationId: operation.id,
          phase,
          routeOperation: operation
        });
        return currentOperation?.id === operation.id ? currentOperation : null;
      } catch {
        return null;
      }
    };
    const admissionAuthorizationOperation: any =
      authorizationOperationForPhase("admission");
    let admissionProtectedSinkAuthority: any = null;
    const authEnabled: any = true;
    let processIdentityVerification: any = null;
    const processIdentityRequired: any = operation.processIdentity?.required === true;
    if (!skipAuthorization && processIdentityRequired) {
      processIdentityVerification = typeof verifyProcessIdentity === "function"
        ? await verifyProcessIdentity({
            operation: admissionAuthorizationOperation,
            request,
            requestBody,
            url,
            method,
            transport,
            input: operationInput,
            ...(admissionTargetSelector ? { phase: "admission" } : {})
          })
        : {
            ok: false,
            status: 503,
            reasonCode: "process_identity_verifier_missing",
            error: "Process identity verifier is not registered for this transport."
          };
      if (!processIdentityVerification.ok) {
        const status: any = Number(processIdentityVerification.status || processIdentityVerification.statusCode || 401) || 401;
        const error: any = processIdentityVerification.error || "process identity verification denied";
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
        request.__meshrixProcessIdentity = processIdentityVerification;
      }
      if (admissionTargetSelector) {
        admissionProtectedSinkAuthority = protectedSinkAuthorityFacts(
          processIdentityVerification
        );
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
    const processIdentityAuthorizes: any =
      processIdentityRequired &&
      processIdentityVerification?.ok === true &&
      operation.processIdentity?.authorizes === true;
    const shouldRunConsoleAuthorization: any =
      !processIdentityAuthorizes &&
      !skipAuthorization &&
      operation.externalAuth !== true &&
      typeof authorizeOperation === "function";
    let externalAuthVerification: any = null;

    if (!skipAuthorization && operation.externalAuth === true) {
      const verification: any = await verifyExternalAuth({
        operation: admissionAuthorizationOperation,
        controllers,
        request,
        input: operationInput,
        requestBody,
        url,
        params,
        method,
        transport,
        ...(admissionTargetSelector ? { phase: "admission" } : {})
	      });
	      if (!verification.ok) {
	        const status: any = Number(verification.status || verification.statusCode || 401) || 401;
	        const error: any = verification.error || verification.message || "external authentication denied";
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
	      externalAuthVerification = verification;
	      if (admissionTargetSelector) {
	        admissionProtectedSinkAuthority =
	          protectedSinkAuthorityFacts(verification);
	      }
	      if (request && typeof request === "object") {
	        request.__meshrixExternalAuth = verification;
	        const externalGrantRef: any = firstText(verification.grantRef, verification.grant?.id);
	        const externalDecisionRef: any = firstText(verification.authorizationDecision?.decisionId);
	        const externalPolicyRevision: any = verification.governancePolicyRevision || null;
	        if (externalGrantRef && externalDecisionRef && externalPolicyRevision?.revision) {
	          request.__meshrixOperationRuntimeAuthorization = Object.freeze({
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
      const authorization: any = await authorizeOperation({
        request,
        operation: admissionAuthorizationOperation,
        method,
        url,
        input: operationInput,
        ...(admissionTargetSelector ? { phase: "admission" } : {})
	      });
	      if (!authorization.ok) {
	        const authorizationSession: any = authorization.session || null;
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
	          error: authorization.error || "authorization denied",
	          authorizationDecisionId: authorization.authorizationDecision?.decisionId || ""
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
	      if (admissionTargetSelector) {
	        admissionProtectedSinkAuthority =
	          protectedSinkAuthorityFacts(authorization);
	      }
	      authSession = authorization.session || null;
	      actor = actorFromInput({ actor: providedActor, authSession });
        if (request && typeof request === "object") {
          const subjectRef: any = firstText(
            authSession?.user?.subjectId,
            authSession?.user?.userId,
            authSession?.user?.id
          );
          const sessionRef: any = firstText(authSession?.sessionId, authSession?.id, subjectRef);
          request.__meshrixOperationRuntimeAuthorization = Object.freeze({
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
      const approvedPendingOperation: any = request?.__meshrixToolRuntimeAuthorization?.approvedPendingOperation || null;
      const authorizationDecision: any = await dispatcherAuthorizationEngine.evaluate({
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
	        const missingScopes: any = authorizationDecision.missingScopes || [];
	        const error: any = missingScopes.length > 0
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
	          error,
	          authorizationDecisionId: authorizationDecision.decisionId || ""
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
	      if (admissionTargetSelector) {
	        admissionProtectedSinkAuthority = protectedSinkAuthorityFacts(
	          request?.__meshrixToolRuntimeAuthorization || {}
	        );
	      }
	    } else if (operation.externalAuth !== true && operation.public !== true && ["http", "rpc"].includes(transport)) {
	      const error: any = "Operation authorizer is not registered for this transport.";
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
	    } else if (operation.externalAuth !== true && operation.public === true) {
	      appendRiskGate({
	        controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
	        decision: "allow",
	        reasonCode: "allowed_public_without_authorizer",
	        details: {
	          transport,
	          publicAccess: true
	        }
	      });
	    }

    if (admissionTargetSelector && !admissionProtectedSinkAuthority) {
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
        decision: "deny",
        reasonCode: "final_protected_sink_admission_authority_required",
        statusCode: 403,
        details: {
          phase: "admission"
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
        error: "Protected sink admission authority is unavailable."
      });
      sendOperationDenied(response, 403, {
        error: "受保护操作的准入授权事实不可用。",
        traceId: traceContext.traceId
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

    const safety: any = evaluateOperationSafety({
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
    const protectedEffect: any = requiresExecutionAuthorizationRevalidation(operation);
    let preparedProofEntry: any = null;
    try {
      preparedProofEntry = await ensureProofLifecycleStarted({
        reasonCode: "policy_allowed",
        required: protectedEffect
      });
      if (protectedEffect && !firstText(preparedProofEntry?.ledgerEventId)) {
        throw Object.assign(new Error("Protected operation proof preparation returned no lifecycle reference."), {
          code: "operation_proof_prepare_incomplete",
          statusCode: 503
        });
      }
    } catch (error: any) {
      appendRiskGate({
        controlId: DISPATCHER_RISK_CONTROL_IDS.execute,
        decision: "deny",
        reasonCode: error?.code || "operation_proof_prepare_failed",
        statusCode: 503,
        details: { phase: "prepare" }
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
        error: "Protected operation proof preparation failed."
      });
      sendOperationDenied(response, 503, {
        error: "受保护操作的最低证据不可用。",
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
    }
    const executionAuthorizationRevalidator: any =
      typeof revalidateAuthorization === "function"
        ? revalidateAuthorization
        : shouldRunConsoleAuthorization
          ? authorizeOperation
          : processIdentityAuthorizes &&
              typeof processIdentityVerification?.revalidateAuthorization === "function"
            ? processIdentityVerification.revalidateAuthorization
            : typeof externalAuthVerification?.revalidateAuthorization === "function"
              ? externalAuthVerification.revalidateAuthorization
              : null;
    const permitRequestDigest: any = digestGovernedExecutionRequest({
      operationId: operation.id,
      transport,
      method,
      path: url?.pathname || "",
      input: operationInput,
      requestBody
    });
    let dispatchMayHaveStarted: any = false;

    try {
      logOperation(logger, "debug", operationEventName(transport, "started"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        concurrencyClass: operation.concurrency?.workloadClass || "standard",
        concurrencyKey: operation.concurrency?.key || operation.id,
        maxParallel: operation.concurrency?.maxParallel || 1
      });
      const executionResult: any = await withOperationLock({
        operation: operationConcurrencyContract(operation),
        lockManager,
        concurrencyScope,
        signal,
        run: async (operationLock?: any) : Promise<any> => {
          let finalProtectedSinkPermit: any = null;
          if (protectedEffect) {
            if (typeof executionAuthorizationRevalidator !== "function") {
              return executionAuthorizationDenied({
                status: 503,
                reasonCode: "execution_authorizer_missing",
                error: "Execution authorization revalidator is not registered."
              });
            }
            const executionAuthorizationOperation: any =
              authorizationOperationForPhase("execution");
            if (!executionAuthorizationOperation) {
              return executionAuthorizationDenied({
                status: 403,
                reasonCode: "operation_authority_revision_changed",
                error: "Operation authority changed after admission."
              });
            }
            let currentAuthorization: any;
            try {
              currentAuthorization = await executionAuthorizationRevalidator({
                phase: "execution",
                operation: executionAuthorizationOperation,
                request,
                requestBody,
                url,
                params,
                input: operationInput,
                method,
                transport,
                authSession,
                actor,
                signal: operationLock?.signal || signal
              });
            } catch {
              return executionAuthorizationDenied({
                status: 503,
                reasonCode: "execution_authorization_failed",
                error: "Execution authorization revalidation failed."
              });
            }
            if (currentAuthorization?.ok !== true) {
              return executionAuthorizationDenied(currentAuthorization);
            }
            const targetSelector: any = finalProtectedSinkTargetSelector(
              operation,
              operationInput
            );
            if (targetSelector) {
              const executionAuthority: any =
                protectedSinkAuthorityFacts(currentAuthorization);
              if (!executionAuthority) {
                return executionAuthorizationDenied({
                  status: 403,
                  reasonCode:
                    "final_protected_sink_authority_facts_required",
                  error:
                    "Final protected sink authority facts are required."
                });
              }
              if (!protectedSinkAuthoritiesCanonicalEqual(
                admissionProtectedSinkAuthority,
                executionAuthority
              )) {
                return executionAuthorizationDenied({
                  status: 403,
                  reasonCode:
                    "final_protected_sink_admission_authority_changed",
                  error:
                    "Protected sink authority changed after admission."
                });
              }
              try {
                finalProtectedSinkPermit = createFinalProtectedSinkAttempt({
                  audience: "upstream-structured-http-final-effect",
                  subject: executionAuthority.subject,
                  operationId: operation.id,
                  requestDigest: permitRequestDigest,
                  context: executionAuthority.context,
                  targetSelector,
                  proofRef: preparedProofEntry.ledgerEventId,
                  authorization: Object.freeze({
                    decisionId: firstText(
                      currentAuthorization.authorizationDecision?.decisionId,
                      currentAuthorization.decisionId,
                      request?.__meshrixOperationRuntimeAuthorization?.policy?.decisionId
                    ),
                    reasonCode: firstText(
                      currentAuthorization.authorizationDecision?.reasonCode,
                      currentAuthorization.reasonCode
                    ),
                    grantRevision: executionAuthority.context.grantRevision,
                    policyRevision: executionAuthority.context.policyRevision
                  }),
                  approval: Object.freeze({
                    approvalRevision: executionAuthority.context.approvalRevision,
                    required: safety.safety?.requiresConfirmation === true
                  }),
                  risk: Object.freeze({
                    class: operation.safety?.risk || "",
                    riskRevision: executionAuthority.context.riskRevision
                  }),
                  signal: operationLock?.signal || signal,
                  revalidateCurrentAuthority: async ({ binding }: Record<string, any>) : Promise<any> => {
                    const finalAuthorizationOperation: any =
                      authorizationOperationForPhase("final-protected-sink");
                    if (!finalAuthorizationOperation) {
                      return Object.freeze({
                        allowed: false,
                        revoked: true
                      });
                    }
                    let finalAuthorization: any;
                    try {
                      finalAuthorization = await executionAuthorizationRevalidator({
                        phase: "final-protected-sink",
                        operation: finalAuthorizationOperation,
                        request,
                        requestBody,
                        url,
                        params,
                        input: operationInput,
                        method,
                        transport,
                        authSession,
                        actor,
                        signal: operationLock?.signal || signal,
                        sinkBinding: binding
                      });
                    } catch {
                      logOperation(logger, "warn", operationEventName(transport, "denied"), {
                        operationId: operation.id,
                        phase: "final-protected-sink",
                        reasonCode: "final_authorization_revalidation_failed"
                      });
                      return Object.freeze({
                        allowed: false,
                        revoked: false
                      });
                    }
                    const revoked: any = finalAuthorityRevoked(finalAuthorization);
                    if (
                      finalAuthorization?.ok !== true ||
                      finalAuthorization.authorizationDecision?.allowed === false ||
                      revoked
                    ) {
                      logOperation(logger, "warn", operationEventName(transport, "denied"), {
                        operationId: operation.id,
                        phase: "final-protected-sink",
                        reasonCode: String(
                          finalAuthorization?.reasonCode ||
                          finalAuthorization?.authorizationDecision?.reasonCode ||
                          (revoked ? "final_authority_revoked" : "final_authority_denied")
                        ).replace(/[^a-z0-9_]+/giu, "_").slice(0, 96)
                      });
                      return Object.freeze({
                        allowed: false,
                        revoked
                      });
                    }
                    const currentSafety: any = evaluateOperationSafety({
                      operation,
                      requestBody,
                      url,
                      params,
                      request,
                      authSession: finalAuthorization.session || authSession,
                      authEnabled
                    });
                    if (!currentSafety.ok) {
                      logOperation(logger, "warn", operationEventName(transport, "denied"), {
                        operationId: operation.id,
                        phase: "final-protected-sink",
                        reasonCode: "final_operation_safety_denied"
                      });
                      return Object.freeze({
                        allowed: false,
                        revoked: false
                      });
                    }
                    const currentAuthority: any =
                      protectedSinkAuthorityFacts(finalAuthorization);
                    if (!currentAuthority) {
                      return Object.freeze({
                        allowed: false,
                        revoked: false
                      });
                    }
                    return Object.freeze({
                      allowed: true,
                      revoked: false,
                      subject: currentAuthority.subject,
                      context: currentAuthority.context
                    });
                  }
                });
              } catch {
                return executionAuthorizationDenied({
                  status: 503,
                  reasonCode: "final_protected_sink_attempt_mint_failed",
                  error: "Final protected sink attempt could not be minted."
                });
              }
            }
          }
		          notifyNarrowTransition(request, "operation.execute_start", "executing");
	          dispatchMayHaveStarted = true;
	          notifySideEffectStart(request);
	          appendRiskGate({
	            controlId: DISPATCHER_RISK_CONTROL_IDS.execute,
	            decision: "allow",
	            reasonCode: "execute_started",
	            details: {
	              concurrencyClass: operation.concurrency?.workloadClass || "standard",
	              concurrencyKey: operation.concurrency?.key || operation.id,
	              maxParallel: operation.concurrency?.maxParallel || 1
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
              finalProtectedSinkPermit
	          });
	        }
	      });
      if (executionResult?.authorizationDenied === true) {
        appendRiskGate({
          controlId: DISPATCHER_RISK_CONTROL_IDS.operationAuthorize,
          decision: "deny",
          reasonCode: executionResult.reasonCode,
          statusCode: executionResult.statusCode,
          details: {
            authorizationDecisionId: executionResult.authorizationDecision?.decisionId || "",
            phase: "execution"
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
          statusCode: executionResult.statusCode,
          error: executionResult.error,
          authorizationDecisionId: executionResult.authorizationDecision?.decisionId || ""
        });
        logOperation(logger, "warn", operationEventName(transport, "denied"), {
          requestId: requestIdFromRequest(request),
          operationId: operation.id,
          reason: executionResult.reasonCode,
          status: executionResult.statusCode
        });
        sendOperationDenied(response, executionResult.statusCode, {
          error: "执行授权已失效。",
          traceId: traceContext.traceId
        });
        notifyNarrowTransition(request, "operation.policy_deny", "policy_denied");
        return {
          ok: false,
          handled: true,
          statusCode: executionResult.statusCode,
          operation,
          input: operationInput,
          traceContext,
          riskControl: riskControlEnvelope
        };
      }
	      const statusCode: any = response?.statusCode || 200;
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
	    } catch (error: any) {
        const disposition: any = dispatchMayHaveStarted ? "in_doubt" : "failed";
        try {
	        await finishProofWithAudit({
	          operationAuditStore,
	          operation,
	          transport,
            authSession,
            actor,
	          input: operationInput,
	          status: disposition,
	          statusCode: response?.statusCode || 500,
	          startedAt,
	          error: dispatchMayHaveStarted
              ? "Operation outcome requires governed reconciliation."
              : error instanceof Error ? error.message : "operation failed"
	        }, {
            outcomeKind: disposition,
            failed: !dispatchMayHaveStarted,
            result: { reconciliationRequired: dispatchMayHaveStarted }
          });
        } catch {
          // Evidence settlement cannot convert a possible effect into a safe failure.
        }
      logOperation(logger, "error", operationEventName(transport, "failed"), {
        requestId: requestIdFromRequest(request),
        operationId: operation.id,
        durationMs: Date.now() - startedAt,
        error: summarizeError(error)
      });
      notifyNarrowTransition(request, "operation.fail", "failed");
      if (dispatchMayHaveStarted) {
        throw Object.assign(new Error("Operation outcome is in doubt and requires governed reconciliation."), {
          code: "operation_outcome_in_doubt",
          statusCode: 503,
          retryable: false,
          cause: error
        });
      }
      throw error;
    }
  });
}
