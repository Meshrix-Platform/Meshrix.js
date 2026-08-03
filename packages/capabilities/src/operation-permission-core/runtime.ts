import { getRuntimeLogger, summarizeForLog } from "@meshrix/foundation/observability/runtime-logger";
import { traceContextFromRequest } from "@meshrix/foundation/observability/trace-context";
import { canonicalHash } from "@meshrix/foundation/serialization/canonical-json";
import {
  approvalAlreadySatisfiesPolicy,
  approvalLayers,
  authorizationGrantId,
  authorizationPolicy,
  authorizationSubject,
  authorizationSubjectId,
  authorizationSubjectType,
  nowIso,
  parseJsonObject,
  pendingResumeInput,
  policyRevisionSummary,
  randomId,
  sourceIpFromRequest,
  trustedApprovedPendingOperation
} from "./runtime-common.ts";
import { revalidateGrantForExecution } from "./revalidate-grant-for-execution.ts";
import { denyInvalidInputExecution } from "./runtime-denials.ts";
import { completeDryRunExecution } from "./runtime-dry-run.ts";
import { appendAuthorizationDecision } from "./runtime-execution-support.ts";
import { completeToolExecutionFailure } from "./runtime-execution-failure.ts";
import { completeHandlerPendingApproval } from "./runtime-handler-pending.ts";
import { createPendingOperationRuntime } from "./runtime-pending.ts";
import { jsonByteLength, resultSummaryFromPayload } from "./runtime-result-summary.ts";
import { validateInputSchema } from "./runtime-schema.ts";
import {
  buildDirectOperationRequest,
  capturedBuffer,
  createCapturedResponse,
  parseCapturedJson,
  runWithAbortableTimeout
} from "./runtime-transport.ts";
import { toolActorFromAuthorization } from "./runtime-tool-actor.ts";
import { denyUnknownToolExecution } from "./runtime-unknown-tool.ts";
import { apiKeyAuthorizationEvaluationInput } from "./api-key-distribution.ts";

const RISK_RANK: Readonly<Record<string, any>> = Object.freeze({ read_only: 0, safe_write: 1, repair_write: 2, destructive: 3 });

function protectedSinkApprovalRevision(approvedPendingOperation: any = null) : string {
  return canonicalHash({
    pendingOperationId: String(approvedPendingOperation?.pendingOperationId || "none"),
    status: String(approvedPendingOperation?.status || "none"),
    bindingDigest: String(approvedPendingOperation?.requiredApproval?.operationBinding?.bindingDigest || "none")
  });
}

function apiKeyProtectedSinkAuthority({
  authorization,
  policySummary,
  tool,
  approvedPendingOperation = null
}: Record<string, any>): any {
  if (authorization?.credentialKind !== "scoped_api_key") return null;
  const lifecycleRevision: any = Number(authorization.lifecycleRevision || 0);
  const policyFingerprint: any = String(authorization.policyFingerprint || "");
  const workloadPrincipalId: any = String(authorization.workloadPrincipalId || "");
  const organizationNodeId: any = String(authorization.organizationNodeId || "");
  const keyId: any = String(authorization.keyId || "");
  if (!Number.isSafeInteger(lifecycleRevision) || lifecycleRevision < 1 || !policyFingerprint ||
      !workloadPrincipalId || !organizationNodeId || !keyId) return null;
  const subjectGeneration: any = canonicalHash({
    kind: "scoped_api_key",
    workloadPrincipalId,
    organizationNodeId
  });
  return Object.freeze({
    subject: Object.freeze({
      generation: subjectGeneration,
      subjectId: workloadPrincipalId,
      tenantId: organizationNodeId,
      type: "scoped-api-key"
    }),
    context: Object.freeze({
      approvalRevision: protectedSinkApprovalRevision(approvedPendingOperation),
      grantRevision: canonicalHash({ lifecycleRevision, policyFingerprint }),
      policyRevision: canonicalHash({
        policyFingerprint,
        governance: policySummary?.governancePolicyRevision || null
      }),
      riskRevision: canonicalHash({
        toolId: String(tool?.id || ""),
        risk: String(tool?.risk || ""),
        maximumRisk: String(authorization.policy?.maximumRisk || "")
      }),
      workloadGeneration: canonicalHash({ keyId, lifecycleRevision, subjectGeneration })
    })
  });
}

function toolGrantProtectedSinkAuthority({
  authorization,
  policySummary,
  tool,
  approvedPendingOperation = null
}: Record<string, any>): any {
  const grant: any = authorization?.grant;
  const grantId: any = String(grant?.id || "");
  const projectionFingerprint: any = String(grant?.projectionFingerprint || "");
  if (!grantId || !projectionFingerprint) return null;
  const subject: any = authorizationSubject(authorization);
  const subjectId: any = String(subject.subjectId || grantId);
  const tenantId: any = String(
    subject.tenantId ||
    grant.metadata?.organizationNodeId ||
    grant.metadata?.tenantId ||
    "local"
  );
  const subjectGeneration: any = canonicalHash({
    kind: "tool_grant",
    grantId,
    projectionFingerprint
  });
  return Object.freeze({
    subject: Object.freeze({
      generation: subjectGeneration,
      subjectId,
      tenantId,
      type: "tool-grant"
    }),
    context: Object.freeze({
      approvalRevision: protectedSinkApprovalRevision(approvedPendingOperation),
      grantRevision: canonicalHash({ grantId, projectionFingerprint }),
      policyRevision: canonicalHash({
        projectionFingerprint,
        grantPolicyRevision: Number(policySummary?.grantPolicyRevision || 0),
        governance: policySummary?.governancePolicyRevision || null
      }),
      riskRevision: canonicalHash({
        toolId: String(tool?.id || ""),
        risk: String(tool?.risk || ""),
        requiresApproval: tool?.requiresApproval === true
      }),
      workloadGeneration: canonicalHash({
        grantId,
        subjectGeneration,
        tokenFamilyId: String(grant.tokenFamilyId || "")
      })
    })
  });
}

function protectedSinkAuthority({
  authorization,
  apiKeyAuthorization = null,
  policySummary,
  tool,
  approvedPendingOperation = null
}: Record<string, any>): any {
  return apiKeyAuthorization
    ? apiKeyProtectedSinkAuthority({
        authorization: apiKeyAuthorization,
        policySummary,
        tool,
        approvedPendingOperation
      })
    : toolGrantProtectedSinkAuthority({
        authorization,
        policySummary,
        tool,
        approvedPendingOperation
      });
}

function toolWithDynamicCapability(tool: any = null, context: Record<string, any> = {}) : any {
  const descriptor: any = context?.dynamicCapability && typeof context.dynamicCapability === "object" && !Array.isArray(context.dynamicCapability)
    ? context.dynamicCapability
    : null;
  if (!tool || !descriptor) return tool;
  const staticRisk: any = String(tool.risk || "read_only");
  const dynamicRisk: any = String(descriptor.risk || "read_only");
  const risk: any = (RISK_RANK[dynamicRisk] ?? 0) > (RISK_RANK[staticRisk] ?? 0) ? dynamicRisk : staticRisk;
  const requiredScopes: any[] = [...new Set<any>([
    ...(Array.isArray(tool.requiredScopes) ? tool.requiredScopes : []),
    ...(Array.isArray(descriptor.requiredScopes) ? descriptor.requiredScopes : [])
  ].map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
  return {
    ...tool,
    risk,
    requiredScopes,
    requiresApproval: tool.requiresApproval === true || descriptor.approvalPolicy?.requiresApproval === true,
    approvalScope: String(descriptor.approvalPolicy?.approvalScope || tool.approvalScope || ""),
    requiredApproval: descriptor.approvalPolicy?.requiredApproval && typeof descriptor.approvalPolicy.requiredApproval === "object" && !Array.isArray(descriptor.approvalPolicy.requiredApproval)
      ? descriptor.approvalPolicy.requiredApproval
      : tool.requiredApproval || {},
    resourceContext: {
      ...(tool.resourceContext || {}),
      ...(descriptor.resourceContext || {})
    }
  };
}

export function createToolExecutionRuntime({
  registry,
  store,
  policyEngine,
  securityPermissions = null,
  operations = [],
  operationDispatcher,
  operationProofSubstrate = null,
  controllers,
  operationAuditStore = null,
  operationConcurrencyScope = undefined,
  apiKeyDistributionProvider = null,
  protocolEventBus = null,
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  if (typeof operationDispatcher !== "function") {
    throw new TypeError("Tool execution runtime requires operationDispatcher.");
  }
  let operationsById: any = new Map<any, any>(operations.map((operation?: any) : any => [operation.id, operation]));

  function refreshOperations(nextOperations: any = []) : any {
    operationsById = new Map<any, any>(nextOperations.map((operation?: any) : any => [operation.id, operation]));
    return { ok: true, operationCount: operationsById.size };
  }

  function logTool(level?: any, event?: any, details: Record<string, any> = {}) : any {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    logger[level](event, details);
  }

  async function publishEvent(topic?: any, payload?: any, options: Record<string, any> = {}) : Promise<any> {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return;
    }
    await protocolEventBus.publish(topic, payload, options).catch(() : any => {});
  }

  async function executeTool({
    toolId,
    input = {},
    request,
    context = {},
    dryRun = false,
    directOperation = null,
    directUrl = null,
    directRequestBody = null,
    directParams = null,
    requestBody = Buffer.alloc(0),
    requestUrl = null,
    requestMethod = "POST",
    signal = null,
    authorizedGrant = null,
    apiKeyAuthorization = null,
    approvedPendingOperation = null
  }: Record<string, any> = {}) : Promise<any> {
    const trustedApproval: any = trustedApprovedPendingOperation(approvedPendingOperation);
    const requestTrace: any = traceContextFromRequest(request);
    const traceId: any = context.traceId || requestTrace?.traceId || randomId("trace");
    const toolExecutionId: any = randomId("tool_exec");
    const startedAtMs: any = Date.now();
    const startedAt: any = nowIso();
    const inputBytes: any = jsonByteLength(input);
    const tool: any = toolWithDynamicCapability(registry.getTool(toolId), context);
    const operation: any = directOperation || operationsById.get(tool?.operationId || "");
    const profile: any = context.profileId
      ? registry.listProfiles().find((item?: any) : any => item.id === context.profileId)
      : null;
    const delegatedChildOperation: any = context.delegatedChildOperation && typeof context.delegatedChildOperation === "object" && !Array.isArray(context.delegatedChildOperation)
      ? context.delegatedChildOperation
      : null;
    const appendExecution: any = async (entry: Record<string, any> = {}) : Promise<any> => {
      const payload: Record<string, any> = {
        ...entry,
        ...(delegatedChildOperation ? { delegatedChildOperation } : {})
      };
      if (typeof store.appendExecutionAnchored === "function") {
        return store.appendExecutionAnchored(payload);
      }
      return store.appendExecution(payload);
    };

    if (!tool || !operation) {
      return await denyUnknownToolExecution({
        tool,
        toolId,
        logTool,
        summarizeForLog,
        input,
        appendExecution,
        store,
        traceId,
        toolExecutionId,
        startedAt,
        inputBytes,
        securityPermissions
      });
    }

    logTool("info", "operation_permission.execute.started", {
      traceId,
      toolExecutionId,
      toolId: tool.id,
      operationId: tool.operationId,
      risk: tool.risk,
      dryRun,
      input: summarizeForLog(input),
      context: summarizeForLog(context)
    });
    await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status: "started" }, { type: "tools.execution.started" });

    const apiKeyEvaluation: any = apiKeyAuthorization
      ? apiKeyAuthorizationEvaluationInput(apiKeyAuthorization)
      : null;
    const apiKeyRestriction: any = apiKeyEvaluation?.restriction || null;
    const authorization: any = apiKeyAuthorization
      ? {
          ok: true,
          restriction: apiKeyRestriction,
          subject: apiKeyEvaluation.subject,
          apiKeyAuthorization
        }
      : authorizedGrant
      ? await Promise.resolve(revalidateGrantForExecution({
          store,
          capturedGrant: authorizedGrant,
          request,
          requiredScopes: tool.requiredScopes,
          tool,
          context
        }))
      : await store.authorizeRequest({
          request,
          requiredScopes: tool.requiredScopes,
          tool,
          context,
          recordUse: dryRun !== true,
          requestBody,
          url: requestUrl,
          method: requestMethod
        });
    const runtimeSubject: any = authorizationSubject(authorization);
    const runtimeSubjectId: any = authorizationSubjectId(authorization);
    const runtimeSubjectType: any = authorizationSubjectType(authorization);
    const runtimeGrantId: any = authorizationGrantId(authorization);
    if (!authorization.ok) {
      const durationMs: any = Date.now() - startedAtMs;
      logTool("warn", "operation_permission.execute.denied", {
        traceId,
        toolExecutionId,
        toolId: tool.id,
        operationId: tool.operationId,
        risk: tool.risk,
        reason: authorization.reasonCode || "authorization_denied",
        durationMs
      });
      const decision: Record<string, any> = {
        effect: "deny",
        reasonCode: authorization.reasonCode || "authorization_denied",
        decisionId: randomId("policy")
      };
      if (typeof store.appendPolicyDecisionAnchored === "function") {
        await store.appendPolicyDecisionAnchored({
          ...decision,
          toolExecutionId,
          traceId,
          toolId: tool.id,
          grantId: runtimeGrantId,
          missingScopes: authorization.missingScopes || []
        });
      } else {
        store.appendPolicyDecision({
          ...decision,
          toolExecutionId,
          traceId,
          toolId: tool.id,
          grantId: runtimeGrantId,
          missingScopes: authorization.missingScopes || []
        });
      }
      appendAuthorizationDecision(securityPermissions, {
        ...decision,
        traceId,
        toolExecutionId,
        toolId: tool.id,
        operationId: tool.operationId,
        grantId: runtimeGrantId,
        subject: runtimeSubject,
        resource: {
          toolId: tool.id,
          operationId: tool.operationId,
          risk: tool.risk
        },
        missingScopes: authorization.missingScopes || [],
        missingCapabilities: authorization.missingCapabilities || [],
        redactedReason: authorization.error || "Tool token authorization denied."
      });
      await appendExecution({
        toolExecutionId,
        traceId,
        toolId: tool.id,
        toolVersion: tool.version,
        toolsetIds: tool.toolsets,
        subjectType: runtimeSubjectType,
        subjectId: runtimeSubjectId,
        grantId: runtimeGrantId,
        agentId: context.agentId || "",
        profileId: context.profileId || "",
        operationId: tool.operationId,
        risk: tool.risk,
        decision: "deny",
        input,
        status: "denied",
        errorCode: decision.reasonCode,
        durationMs,
        policyDecisionId: decision.decisionId,
        sourceIp: sourceIpFromRequest(request),
        userAgent: request?.headers?.["user-agent"] || "",
        startedAt,
        finishedAt: nowIso()
      });
      store.appendMetric({
        traceId,
        toolId: tool.id,
        grantId: runtimeGrantId,
        profileId: context.profileId || "",
        status: "denied",
        risk: tool.risk,
        durationMs,
        inputBytes,
        reasonCode: decision.reasonCode
      });
      await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status: "denied" }, { type: "tools.execution.denied" });
      return {
        ok: false,
        status: authorization.status || 403,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          traceId,
          error: {
            code: decision.reasonCode,
            message: authorization.error || "Tool call denied.",
            details: {
              missingScopes: authorization.missingScopes || [],
              missingCapabilities: authorization.missingCapabilities || []
            }
          }
        }
      };
    }

    const policy: any = await policyEngine.evaluate({
      tool,
      grant: authorization.grant,
      restriction: authorization.restriction,
      subject: authorization.subject,
      credentialKind: apiKeyAuthorization ? "scoped_api_key" : "tool_grant",
      profile,
      input,
      request,
      context,
      dryRun,
      traceId,
      toolExecutionId
    });

    // Approval proof must come from resumePendingOperation's internal parameter, never caller context.
    const policySummary: any = policyRevisionSummary(policy);
    const admissionProtectedSinkAuthority: any = protectedSinkAuthority({
      authorization,
      apiKeyAuthorization,
      policySummary,
      tool,
      approvedPendingOperation: trustedApproval
    });
    const approvalOperationBindingCore: Record<string, any> = {
      schemaVersion: "v0.0.1:operation-permission:approval-operation-binding-1",
      operationId: String(tool.operationId || ""),
      upstreamProjection: {
        sourceRevision: Number(tool.sourceRevision || 0),
        sourceDigest: String(tool.sourceDigest || ""),
        serviceId: String(context.dynamicCapability?.serviceId || tool.serviceId || ""),
        operationKey: String(context.dynamicCapability?.operationKey || tool.operationKey || ""),
        upstreamToolName: String(context.dynamicCapability?.upstreamToolName || ""),
        capabilityDigest: context.dynamicCapability
          ? canonicalHash(context.dynamicCapability)
          : ""
      },
      resource: {
        workspaceId: String(input?.workspaceId || input?.["workspace-id"] || ""),
        targetWorkspaceId: String(input?.targetWorkspaceId || input?.["target-workspace-id"] || ""),
        resourceType: String(input?.resourceType || input?.["resource-type"] || ""),
        resourceId: String(input?.resourceId || input?.["resource-id"] || ""),
        proposalRef: String(input?.proposalRef || input?.["proposal-ref"] || ""),
        previewDigest: String(input?.previewDigest || input?.["preview-digest"] || ""),
        outputDigest: String(input?.outputDigest || input?.["output-digest"] || ""),
        policyDigest: String(input?.policyDigest || input?.["policy-digest"] || "")
      },
      policyRevision: {
        grantPolicyRevision: policySummary.grantPolicyRevision,
        governancePolicyRevision: policySummary.governancePolicyRevision.revision
      },
      credentialBinding: {
        kind: apiKeyAuthorization ? "scoped_api_key" : "tool_grant",
        id: apiKeyAuthorization ? String(apiKeyAuthorization.keyId || "") : runtimeGrantId,
        policyFingerprint: String(
          authorization.restriction?.policyFingerprint || authorization.grant?.projectionFingerprint || ""
        )
      },
      grantProjectionFingerprint: String(
        authorization.grant?.projectionFingerprint || authorization.restriction?.policyFingerprint || ""
      )
    };
    const approvalOperationBinding: Record<string, any> = {
      ...approvalOperationBindingCore,
      bindingDigest: canonicalHash(approvalOperationBindingCore)
    };
    if (trustedApproval) {
      const persistedBinding: any = trustedApproval.requiredApproval?.operationBinding;
      const bindingCurrent: any = persistedBinding &&
        persistedBinding.schemaVersion === approvalOperationBinding.schemaVersion &&
        persistedBinding.operationId === approvalOperationBinding.operationId &&
        persistedBinding.bindingDigest === approvalOperationBinding.bindingDigest &&
        trustedApproval.grantId === runtimeGrantId &&
        trustedApproval.operationId === String(tool.operationId || "") &&
        persistedBinding.resource?.workspaceId === approvalOperationBinding.resource.workspaceId &&
        persistedBinding.resource?.targetWorkspaceId === approvalOperationBinding.resource.targetWorkspaceId &&
        persistedBinding.resource?.resourceType === approvalOperationBinding.resource.resourceType &&
        persistedBinding.resource?.resourceId === approvalOperationBinding.resource.resourceId &&
        persistedBinding.resource?.proposalRef === approvalOperationBinding.resource.proposalRef &&
        persistedBinding.resource?.previewDigest === approvalOperationBinding.resource.previewDigest &&
        persistedBinding.resource?.outputDigest === approvalOperationBinding.resource.outputDigest &&
        persistedBinding.resource?.policyDigest === approvalOperationBinding.resource.policyDigest &&
        Number(persistedBinding.policyRevision?.grantPolicyRevision || 0) === approvalOperationBinding.policyRevision.grantPolicyRevision &&
        Number(persistedBinding.policyRevision?.governancePolicyRevision || 0) === approvalOperationBinding.policyRevision.governancePolicyRevision;
      if (!bindingCurrent) {
        const durationMs: any = Date.now() - startedAtMs;
        await appendExecution({
          toolExecutionId,
          traceId,
          toolId: tool.id,
          toolVersion: tool.version,
          toolsetIds: tool.toolsets,
          subjectType: runtimeSubjectType,
          subjectId: runtimeSubjectId,
          grantId: runtimeGrantId,
          agentId: context.agentId || "",
          profileId: context.profileId || "",
          operationId: tool.operationId,
          risk: tool.risk,
          decision: "deny",
          input,
          resultSummary: { type: "approval_binding_denial", policy: policySummary },
          status: "denied",
          errorCode: "pending_approval_binding_stale",
          durationMs,
          policyDecisionId: policy.decisionId,
          sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
          userAgent: request?.headers?.["user-agent"] || "",
          startedAt,
          finishedAt: nowIso()
        });
        store.appendMetric({
          traceId,
          toolId: tool.id,
          grantId: runtimeGrantId,
          profileId: context.profileId || "",
          status: "denied",
          risk: tool.risk,
          durationMs,
          inputBytes,
          reasonCode: "pending_approval_binding_stale"
        });
        await publishEvent("tools.execution", {
          toolExecutionId,
          traceId,
          toolId: tool.id,
          status: "denied"
        }, { type: "tools.execution.denied" });
        return {
          ok: false,
          status: 409,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            traceId,
            error: {
              code: "pending_approval_binding_stale",
              message: "Pending approval no longer matches the current operation, resource, grant, or policy revision."
            }
          }
        };
      }
    }
    async function denyInvalidInput(schemaValidation?: any) : Promise<any> {
      return denyInvalidInputExecution({
        schemaValidation,
        startedAtMs,
        logTool,
        traceId,
        toolExecutionId,
        tool,
        input,
        appendExecution,
        authorization,
        context,
        policy,
        policySummary,
        request,
        store,
        inputBytes,
        publishEvent,
        startedAt
      });
    }

    const approvalAlreadySatisfiesCurrentPolicy: any = approvalAlreadySatisfiesPolicy(policy, trustedApproval);
    const governanceApprovalRequired: any =
      (policy.effect === "needsApproval" || policy.effect === "require_approval") &&
      !approvalAlreadySatisfiesCurrentPolicy;
    const pendingApprovalRequired: any = tool.requiresApproval === true;
    if (
      !dryRun &&
      policy.effect !== "dry_run_only" &&
      (
        governanceApprovalRequired ||
        (["allow", "require_confirmation"].includes(policy.effect) && pendingApprovalRequired && !trustedApproval)
      )
    ) {
      const durationMs: any = Date.now() - startedAtMs;
      const approvalReasonCode: any = governanceApprovalRequired
        ? policy.reasonCode || "governance_approval_required"
        : "tool_approval_required";
      const approvalReason: any = governanceApprovalRequired
        ? policy.redactedReason || "Governance approval is required before execution."
        : `Tool ${tool.id} requires approval before execution.`;
      const policyRequiredApproval: any = policy.requiredApproval && typeof policy.requiredApproval === "object" && !Array.isArray(policy.requiredApproval)
        ? policy.requiredApproval
        : {};
      const toolRequiredApproval: any = tool.requiredApproval && typeof tool.requiredApproval === "object" && !Array.isArray(tool.requiredApproval)
        ? tool.requiredApproval
        : {};
      const approvalLayers: any[] = [...new Set<any>([
        ...(Array.isArray(toolRequiredApproval.approvalLayers) ? toolRequiredApproval.approvalLayers : []),
        ...(Array.isArray(policyRequiredApproval.approvalLayers) ? policyRequiredApproval.approvalLayers : [])
      ].map((layer?: any) : any => String(layer || "").trim()).filter(Boolean))];
      const requiredApproval: Record<string, any> = {
        ...toolRequiredApproval,
        ...policyRequiredApproval,
        operationBinding: approvalOperationBinding,
        ...(approvalLayers.length > 0 ? { approvalLayers } : {})
      };
      const pendingOperation: any = store.createPendingOperation({
        traceId,
        toolExecutionId,
        toolId: tool.id,
        toolVersion: tool.version,
        toolsetIds: tool.toolsets,
        operationId: tool.operationId,
        risk: tool.risk,
        approvalScope: tool.approvalScope || operation.safety?.approvalScope || "",
        requiredApproval,
        approvalLayers,
        grantId: runtimeGrantId,
        agentId: context.agentId || context.agentProfileId || "",
        profileId: context.profileId || context.agentProfileId || "",
        idempotencyKey: context.idempotencyKey || "",
        reasonCode: approvalReasonCode,
        riskReason: approvalReason,
        originalInput: input,
        resumeInput: pendingResumeInput(input, tool.operationId),
        ...(apiKeyAuthorization ? { credentialAuthorization: apiKeyAuthorization } : {}),
        context,
        sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
        userAgent: request?.headers?.["user-agent"] || "",
        expiresAt: context.expiresAt || context.approvalExpiresAt || ""
      });
      await appendExecution({
        toolExecutionId,
        traceId,
        toolId: tool.id,
        toolVersion: tool.version,
        toolsetIds: tool.toolsets,
        subjectType: runtimeSubjectType,
        subjectId: runtimeSubjectId,
        grantId: runtimeGrantId,
        agentId: context.agentId || "",
        profileId: context.profileId || "",
        operationId: tool.operationId,
        risk: tool.risk,
        decision: policy.effect,
        input,
        resultSummary: {
          type: "pending_operation",
          pendingOperationId: pendingOperation.pendingOperationId,
          status: pendingOperation.status,
          requiredApproval: pendingOperation.requiredApproval || {},
          approvalLayers: pendingOperation.approvalLayers || [],
          policy: policySummary
        },
        status: "pending_approval",
        errorCode: approvalReasonCode,
        durationMs,
        policyDecisionId: policy.decisionId,
        approvalId: pendingOperation.pendingOperationId,
        sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
        userAgent: request?.headers?.["user-agent"] || "",
        startedAt,
        finishedAt: nowIso()
      });
      store.appendMetric({
        traceId,
        toolId: tool.id,
        grantId: runtimeGrantId,
        profileId: context.profileId || "",
        status: "pending_approval",
        risk: tool.risk,
        durationMs,
        inputBytes,
        resultBytes: jsonByteLength(pendingOperation),
        reasonCode: approvalReasonCode
      });
      await publishEvent("tools.pending_operation", {
        pendingOperationId: pendingOperation.pendingOperationId,
        traceId,
        toolExecutionId,
        toolId: tool.id,
        operationId: tool.operationId,
        risk: tool.risk,
        status: "pending"
      }, { type: "tools.pending_operation.created" });
      return {
        ok: true,
        status: 202,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          toolExecutionId,
          traceId,
          toolId: tool.id,
          status: "pending_approval",
          pendingOperation,
          policy: policySummary
        }
      };
    }

    const approvalEffectAlreadyGranted: any =
      approvalAlreadySatisfiesCurrentPolicy &&
      (policy.effect === "needsApproval" || policy.effect === "require_approval");
    const confirmationEffectAlreadyGranted: any =
      policy.effect === "require_confirmation" && Boolean(trustedApproval);
    if (
      !approvalEffectAlreadyGranted &&
      !confirmationEffectAlreadyGranted &&
      !["allow", "dry_run_only"].includes(policy.effect)
    ) {
      const durationMs: any = Date.now() - startedAtMs;
      logTool("warn", "operation_permission.execute.denied", {
        traceId,
        toolExecutionId,
        toolId: tool.id,
        operationId: tool.operationId,
        risk: tool.risk,
        reason: policy.reasonCode,
        decisionId: policy.decisionId,
        durationMs
      });
      await appendExecution({
        toolExecutionId,
        traceId,
        toolId: tool.id,
        toolVersion: tool.version,
        toolsetIds: tool.toolsets,
        subjectType: runtimeSubjectType,
        subjectId: runtimeSubjectId,
        grantId: runtimeGrantId,
        agentId: context.agentId || "",
        profileId: context.profileId || "",
        operationId: tool.operationId,
        risk: tool.risk,
        decision: policy.effect,
        input,
        resultSummary: {
          type: "policy_denial",
          policy: policySummary
        },
        status: "denied",
        errorCode: policy.reasonCode,
        durationMs,
        policyDecisionId: policy.decisionId,
        sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
        userAgent: request?.headers?.["user-agent"] || "",
        startedAt,
        finishedAt: nowIso()
      });
      store.appendMetric({
        traceId,
        toolId: tool.id,
        grantId: runtimeGrantId,
        profileId: context.profileId || "",
        status: "denied",
        risk: tool.risk,
        durationMs,
        inputBytes,
        reasonCode: policy.reasonCode
      });
      await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status: "denied" }, { type: "tools.execution.denied" });
      return {
        ok: false,
        status: policy.effect === "require_confirmation" ? 409 : 403,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          traceId,
          error: {
            code: policy.reasonCode,
            message: policy.redactedReason,
            details: {
              decisionId: policy.decisionId,
              policy: policySummary,
              missingScopes: policy.missingScopes,
              missingCapabilities: policy.missingCapabilities,
              missingToolsets: policy.missingToolsets
            }
          }
        }
      };
    }

    if (dryRun || policy.effect === "dry_run_only") {
      return await completeDryRunExecution({
        startedAtMs,
        appendExecution,
        store,
        logTool,
        traceId,
        toolExecutionId,
        tool,
        authorization,
        context,
        policy,
        input,
        inputBytes,
        policySummary,
        request,
        startedAt
      });
    }

      const captured: any = createCapturedResponse();
      const directRequest: any = directOperation
        ? { url: directUrl, requestBody: directRequestBody, params: directParams || {} }
        : buildDirectOperationRequest({ operation, input });
      const operationInput: any = directRequest.input && typeof directRequest.input === "object" && !Array.isArray(directRequest.input)
        ? directRequest.input
        : {
            ...parseJsonObject(directRequest.requestBody),
            ...(directRequest.params || {})
          };
      const schemaValidation: any = validateInputSchema(operation, operationInput);
      if (!schemaValidation.ok) {
        return denyInvalidInput(schemaValidation);
      }

    let apiKeyEffectLease: any = null;
    const revalidateAuthorization: any = async () : Promise<any> => {
      let currentAuthorization: any;
      if (apiKeyAuthorization) {
        if (!apiKeyEffectLease) {
          currentAuthorization = {
            ok: false,
            status: 409,
            reasonCode: "api_key_effect_lease_required",
            error: "API Key effect reservation is unavailable."
          };
        } else {
          await apiKeyDistributionProvider.revalidateEffect(apiKeyEffectLease);
          currentAuthorization = {
            ok: true,
            restriction: apiKeyRestriction,
            subject: runtimeSubject,
            apiKeyAuthorization
          };
        }
      } else {
        currentAuthorization = await store.authorizeRequest({
          request,
          requiredScopes: tool.requiredScopes,
          tool,
          context,
          recordUse: false,
          requestBody,
          url: requestUrl,
          method: requestMethod
        });
      }
      if (!currentAuthorization.ok && authorizedGrant && !apiKeyAuthorization) {
        currentAuthorization = await Promise.resolve(revalidateGrantForExecution({
          store,
          capturedGrant: authorization.grant,
          request,
          requiredScopes: tool.requiredScopes,
          tool,
          context
        }));
      }
      if (
        !currentAuthorization.ok ||
        authorizationSubjectId(currentAuthorization) !== runtimeSubjectId
      ) {
        return {
          ok: false,
          status: currentAuthorization.status || 403,
          reasonCode: currentAuthorization.reasonCode || "execution_grant_denied",
          error: currentAuthorization.error || "Tool grant authorization denied."
        };
      }

      const currentPolicy: any = await policyEngine.evaluate({
        tool,
        grant: currentAuthorization.grant,
        restriction: currentAuthorization.restriction,
        subject: currentAuthorization.subject,
        credentialKind: apiKeyAuthorization ? "scoped_api_key" : "tool_grant",
        profile,
        input,
        request,
        context,
        dryRun: false,
        traceId,
        toolExecutionId
      });
      const currentPolicySummary: any = policyRevisionSummary(currentPolicy);
      const capturedApproval: any =
        trustedApproval &&
        trustedApproval.status === "approved" &&
        Boolean(trustedApproval.expiresAt) &&
        Date.parse(trustedApproval.expiresAt) > Date.now()
          ? trustedApproval
          : null;
      const requiredApprovalLayers: any = approvalLayers(capturedApproval || {});
      const approvalActorId: any = String(
        capturedApproval?.requiredApproval?.operationBinding?.approvalActorId || ""
      );
      const capturedResolvedBy: any = String(
        capturedApproval?.resolvedBy ||
        context?.approval?.resolvedBy ||
        ""
      );
      const approvalActorCurrent: any = Boolean(
        capturedApproval &&
        approvalActorId &&
        capturedResolvedBy &&
        approvalActorId === capturedResolvedBy
      );
      let governanceApprovalCurrent: any =
        requiredApprovalLayers.length === 0 && approvalActorCurrent;
      if (capturedApproval && requiredApprovalLayers.length > 0) {
        if (typeof securityPermissions?.getGovernanceApproval !== "function") {
          return {
            ok: false,
            status: 503,
            reasonCode: "governance_approval_store_unavailable",
            error: "Governance approval store is unavailable."
          };
        }
        const approvalId: any = `pending-${capturedApproval.pendingOperationId}`;
        const currentApprovalRecord: any = await Promise.resolve(
          securityPermissions.getGovernanceApproval(approvalId)
        );
        governanceApprovalCurrent = Boolean(
          currentApprovalRecord &&
          currentApprovalRecord.effect === "allow" &&
          !currentApprovalRecord.revokedAt &&
          Boolean(currentApprovalRecord.expiresAt) &&
          Date.parse(currentApprovalRecord.expiresAt) > Date.now() &&
          approvalActorCurrent &&
          approvalLayers(currentApprovalRecord).every((layer?: any) : any =>
            requiredApprovalLayers.includes(layer)
          ) &&
          requiredApprovalLayers.every((layer?: any) : any =>
            approvalLayers(currentApprovalRecord).includes(layer)
          )
        );
      }
      const currentApproval: any =
        capturedApproval && governanceApprovalCurrent
          ? capturedApproval
          : null;
      const currentApprovalBinding: any = currentApproval?.requiredApproval?.operationBinding;
      const approvalBindingCurrent: any =
        !trustedApproval ||
        (
          currentApprovalBinding &&
          currentApprovalBinding.bindingDigest === approvalOperationBinding.bindingDigest &&
          Number(currentApprovalBinding.policyRevision?.grantPolicyRevision || 0) ===
            currentPolicySummary.grantPolicyRevision &&
          Number(currentApprovalBinding.policyRevision?.governancePolicyRevision || 0) ===
            currentPolicySummary.governancePolicyRevision.revision
        );
      if (!approvalBindingCurrent) {
        return {
          ok: false,
          status: 409,
          reasonCode: "pending_approval_binding_stale",
          error: "Pending approval no longer matches the current authorization policy."
        };
      }

      const approvalSatisfiesPolicy: any =
        approvalAlreadySatisfiesPolicy(currentPolicy, currentApproval);
      const governanceApprovalSatisfied: any =
        (currentPolicy.effect === "needsApproval" ||
          currentPolicy.effect === "require_approval") &&
        approvalSatisfiesPolicy;
      const toolApprovalSatisfied: any =
        tool.requiresApproval !== true || Boolean(currentApproval);
      const policyAllowsExecution: any =
        currentPolicy.effect === "allow" ||
        (currentPolicy.effect === "require_confirmation" && Boolean(currentApproval)) ||
        governanceApprovalSatisfied;
      if (!policyAllowsExecution || !toolApprovalSatisfied) {
        return {
          ok: false,
          status: currentPolicy.effect === "require_confirmation" ? 409 : 403,
          reasonCode: currentPolicy.reasonCode || "execution_policy_denied",
          error: currentPolicy.redactedReason || "Tool execution policy denied.",
          authorizationDecision: currentPolicy
        };
      }
      const effectiveAuthorizationDecision: any = Object.freeze({
        ...currentPolicy,
        allowed: true,
        approvalSatisfied: Boolean(
          currentApproval &&
          (toolApprovalSatisfied || approvalSatisfiesPolicy)
        )
      });
      return {
        ok: true,
        grant: currentAuthorization.grant,
        restriction: currentAuthorization.restriction,
        subject: authorizationSubject(currentAuthorization),
        authorizationDecision: effectiveAuthorizationDecision,
        governancePolicyRevision: currentPolicy.governancePolicyRevision || null,
        ...(protectedSinkAuthority({
          authorization: currentAuthorization,
          apiKeyAuthorization,
          policySummary: currentPolicySummary,
          tool,
          approvedPendingOperation: trustedApproval
        })
          ? {
              protectedSinkAuthority: protectedSinkAuthority({
                authorization: currentAuthorization,
                apiKeyAuthorization,
                policySummary: currentPolicySummary,
                tool,
                approvedPendingOperation: trustedApproval
              })
            }
          : {})
      };
    };

    const previousAuthorization: any = request.__meshrixToolRuntimeAuthorization;
    request.__meshrixToolRuntimeAuthorization = {
      ok: true,
      grant: authorization.grant,
      restriction: authorization.restriction,
      subject: runtimeSubject,
      ...(admissionProtectedSinkAuthority
        ? { protectedSinkAuthority: admissionProtectedSinkAuthority }
        : {}),
      toolExecutionId,
      traceId,
      requiredScopes: tool.requiredScopes,
      policy: policySummary,
      approvedPendingOperation: trustedApproval
        ? (() : any => {
            const operationBinding: any = trustedApproval.requiredApproval.operationBinding;
            const expiresAt: any = String(trustedApproval.expiresAt || "");
            return {
              pendingOperationId: trustedApproval.pendingOperationId,
              operationId: trustedApproval.operationId,
              approvalScope: trustedApproval.approvalScope,
              status: trustedApproval.status,
              current: trustedApproval.status === "approved" && Boolean(expiresAt) && Date.parse(expiresAt) > Date.now(),
              expiresAt,
              grantId: trustedApproval.grantId,
              actorId: operationBinding.approvalActorId,
              workspaceId: operationBinding.resource.workspaceId,
              targetWorkspaceId: operationBinding.resource.targetWorkspaceId,
              policyRevision: operationBinding.policyRevision,
              operationBinding
            };
          })()
        : null
    };
    try {
      if (apiKeyAuthorization && dryRun !== true) {
        if (!apiKeyDistributionProvider?.reserveEffect) {
          throw Object.assign(new Error("API Key effect reservation provider is unavailable."), {
            code: "api_key_authority_unavailable",
            statusCode: 503
          });
        }
        apiKeyEffectLease = await apiKeyDistributionProvider.reserveEffect({
          authorization: apiKeyAuthorization,
          operation: {
            id: tool.id,
            toolId: tool.id,
            serviceId: tool.serviceId || context?.dynamicCapability?.serviceId || "",
            capabilityId: context?.dynamicCapability?.capabilityId || "",
            toolsetIds: tool.toolsets || [],
            scopeIds: tool.requiredScopes || [],
            risk: tool.risk,
            resourceContext: context.resourceContext || tool.resourceContext || {}
          }
        });
        await apiKeyDistributionProvider.revalidateEffect(apiKeyEffectLease);
      }
      const toolActor: any = toolActorFromAuthorization({
        authorization,
        trustedApproval,
        operation,
        tool
      });
      await runWithAbortableTimeout(
        (signal?: any) : any => operationDispatcher({
          operation,
          controllers,
          request,
          response: captured,
          requestBody: directRequest.requestBody,
          url: directRequest.url,
          params: directRequest.params,
          input: operationInput,
          transport: "operation-permission",
          method: operation.http?.method || "POST",
          authorizeOperation: null,
          revalidateAuthorization,
          operationAuditStore,
          operationProofSubstrate,
          concurrencyScope: operationConcurrencyScope,
          logger,
          authSession: { user: toolActor },
          actor: toolActor,
          skipAuthorization: true,
          signal
        }),
        tool.timeoutMs,
        signal
      );
      const buffer: any = capturedBuffer(captured);
      const statusCode: any = captured.statusCode || 200;
      const payload: any = parseCapturedJson(captured);
      const durationMs: any = Date.now() - startedAtMs;
      if (buffer.length > Number(tool.maxResultBytes || 0)) {
        logTool("error", "operation_permission.execute.failed", {
          traceId,
          toolExecutionId,
          toolId: tool.id,
          operationId: tool.operationId,
          risk: tool.risk,
          reason: "result_too_large",
          resultBytes: buffer.length,
          maxResultBytes: tool.maxResultBytes,
          durationMs
        });
        await appendExecution({
          toolExecutionId,
          traceId,
          toolId: tool.id,
          toolVersion: tool.version,
          toolsetIds: tool.toolsets,
          subjectType: runtimeSubjectType,
          subjectId: runtimeSubjectId,
          grantId: runtimeGrantId,
          agentId: context.agentId || "",
          profileId: context.profileId || "",
          operationId: tool.operationId,
          risk: tool.risk,
          decision: policy.effect,
          input,
          resultSummary: {
            type: "oversize",
            byteLength: buffer.length,
            maxResultBytes: tool.maxResultBytes,
            policy: policySummary
          },
          status: "failed",
          errorCode: "result_too_large",
          durationMs,
          policyDecisionId: policy.decisionId,
          sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
          userAgent: request?.headers?.["user-agent"] || "",
          startedAt,
          finishedAt: nowIso()
        });
        store.appendMetric({
          traceId,
          toolId: tool.id,
          grantId: runtimeGrantId,
          profileId: context.profileId || "",
          status: "failed",
          risk: tool.risk,
          durationMs,
          inputBytes,
          resultBytes: buffer.length,
          reasonCode: "result_too_large"
        });
        await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status: "failed" }, { type: "tools.execution.failed" });
        return {
          ok: false,
          status: 413,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            traceId,
            error: {
              code: "result_too_large",
              message: "Tool result exceeds the configured result size limit.",
              details: {
                toolExecutionId,
                byteLength: buffer.length,
                maxResultBytes: tool.maxResultBytes
              }
            }
          }
        };
      }
      const handlerPendingResult: any = await completeHandlerPendingApproval({
        payload,
        statusCode,
        store,
        traceId,
        toolExecutionId,
        tool,
        operation,
        authorization,
        context,
        policy,
        policySummary,
        approvalOperationBinding,
        input,
        inputBytes,
        durationMs,
        request,
        startedAt,
        appendExecution,
        publishEvent
      });
      if (handlerPendingResult) return handlerPendingResult;
      const status: any = statusCode >= 400 ? "failed" : "ok";
      logTool(status === "ok" ? "info" : "error", status === "ok" ? "operation_permission.execute.completed" : "operation_permission.execute.failed", {
        traceId,
        toolExecutionId,
        toolId: tool.id,
        operationId: tool.operationId,
        risk: tool.risk,
        status,
        statusCode,
        resultBytes: buffer.length,
        durationMs
      });
      await appendExecution({
        toolExecutionId,
        traceId,
        toolId: tool.id,
        toolVersion: tool.version,
        toolsetIds: tool.toolsets,
        subjectType: runtimeSubjectType,
        subjectId: runtimeSubjectId,
        grantId: runtimeGrantId,
        agentId: context.agentId || "",
        profileId: context.profileId || "",
        operationId: tool.operationId,
        risk: tool.risk,
        decision: policy.effect,
        input,
        result: payload,
        resultSummary: {
          ...(tool.transport?.binary ? { type: "binary", byteLength: buffer.length } : resultSummaryFromPayload(payload)),
          policy: policySummary
        },
        status,
        errorCode: status === "ok" ? "" : "tool_handler_failed",
        durationMs,
        policyDecisionId: policy.decisionId,
        sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
        userAgent: request?.headers?.["user-agent"] || "",
        startedAt,
        finishedAt: nowIso()
      });
      store.appendMetric({
        traceId,
        toolId: tool.id,
        grantId: runtimeGrantId,
        profileId: context.profileId || "",
        status,
        risk: tool.risk,
        durationMs,
        inputBytes,
        resultBytes: buffer.length,
        reasonCode: status === "ok" ? "" : "tool_handler_failed"
      });
      await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status }, { type: status === "ok" ? "tools.execution.completed" : "tools.execution.failed" });
      return {
        ok: status === "ok",
        status: statusCode,
        captured,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          toolExecutionId,
          traceId,
          toolId: tool.id,
          status,
          result: payload?.result !== undefined ? payload.result : payload,
          ...(authorization.grant ? { grant: authorization.grant } : {}),
          policy: policySummary
        }
      };
    } catch (error: any) {
      return await completeToolExecutionFailure({
        error, startedAtMs, logTool, traceId, toolExecutionId, tool,
        appendExecution, authorization, context, policy, policySummary,
        input, request, store, inputBytes, publishEvent, startedAt
      });
    } finally {
      if (apiKeyEffectLease) {
        await apiKeyDistributionProvider.releaseEffect(apiKeyEffectLease).catch(() : any => {});
      }
      request.__meshrixToolRuntimeAuthorization = previousAuthorization;
    }
  }

  const resumePendingOperation: any = createPendingOperationRuntime({
    store,
    executeTool,
    publishEvent,
    securityPermissions,
    apiKeyDistributionProvider
  });

  return { refreshOperations, executeTool, resumePendingOperation };
}
