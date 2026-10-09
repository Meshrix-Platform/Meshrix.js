/**
 * Recording governance executor: tenant-scoped console administration of the
 * enterprise-local RecordingPolicy. Tenant identity is always taken from the
 * authenticated session — a request-supplied tenantId may only *confirm* the
 * session tenant, never select another one. The publish path derives the
 * configurer role from the session role, never from caller input, so the
 * policy's own configurerRoles remain the authorization boundary.
 */
import {
  hasConsoleScope,
  protocolPayload,
  result,
  subjectFromAuthSession
} from "./shared.ts";
import {
  normalizeRecordingTenantId,
  RecordingGovernanceError
} from "../recording-governance-provider.ts";

const HANDLED_OPERATIONS: ReadonlySet<string> = new Set([
  "recording_governance.policy.get",
  "recording_governance.sink.health",
  "recording_governance.policy.publish"
]);

const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  tenant_id_invalid: 400,
  recording_policy_expected_revision_invalid: 400,
  recording_policy_invalid: 400,
  recording_policy_revision_invalid: 400,
  recording_policy_change_denied: 403,
  recording_policy_revision_conflict: 409,
  recording_policy_identity_changed: 409,
  recording_policy_revision_not_advanced: 409,
  recording_governance_unavailable: 503,
  recording_policy_required: 503,
  recording_sink_unavailable: 503,
  sink_unavailable: 503,
  sink_write_failed: 503,
  capacity_exceeded: 503
});

function recordingProvider(context: Record<string, any> = {}): any {
  const provider = context.recordingGovernanceProvider;
  if (!provider || typeof provider.describe !== "function"
      || typeof provider.publishPolicy !== "function"
      || typeof provider.sinkHealth !== "function") {
    return null;
  }
  return provider;
}

function unavailableResult(): any {
  return result(503, {
    code: "recording_governance_unavailable",
    error: "Recording governance provider is not configured."
  });
}

/**
 * The effective tenant is the session tenant. A caller may pass tenantId only
 * to assert the same tenant; any other value is a cross-tenant attempt.
 */
function effectiveTenant(context: Record<string, any> = {}, input: Record<string, any> = {}): any {
  const subject = subjectFromAuthSession(context.authSession);
  const requested = String(input.tenantId ?? input["tenant-id"] ?? "").trim();
  try {
    const sessionTenant = normalizeRecordingTenantId(subject.tenantId || "default");
    if (requested && normalizeRecordingTenantId(requested) !== sessionTenant) {
      return { error: result(403, {
        code: "tenant_mismatch",
        error: "The requested tenantId does not match the authenticated session tenant."
      }) };
    }
    return { tenantId: sessionTenant };
  } catch (error: any) {
    return { error: recordingErrorResult(error) };
  }
}

function recordingErrorResult(error: any): any {
  if (error instanceof RecordingGovernanceError || typeof error?.code === "string") {
    const code = String(error.code || "recording_governance_unavailable");
    const status = STATUS_BY_CODE[code] || 500;
    const payload: Record<string, any> = { code, error: error.message || "Recording governance operation failed." };
    if (code === "recording_policy_revision_conflict" && Number(error.currentRevision) > 0) {
      payload.currentRevision = Number(error.currentRevision);
    }
    return result(status, payload);
  }
  return result(500, {
    code: "recording_governance_failed",
    error: "Recording governance operation failed."
  });
}

export async function executeRecordingGovernanceOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: string = String(operationId || "");
  if (!HANDLED_OPERATIONS.has(id)) {
    return null;
  }

  const provider = recordingProvider(context);
  if (!provider) {
    return unavailableResult();
  }

  if (id === "recording_governance.policy.get") {
    if (!hasConsoleScope(context, "recording:read")) {
      return result(403, {
        code: "recording_read_scope_required",
        error: "Reading the recording policy requires recording:read."
      });
    }
    const tenant = effectiveTenant(context, input);
    if (tenant.error) return tenant.error;
    try {
      const snapshot = provider.describe({ tenantId: tenant.tenantId });
      return result(200, protocolPayload({ snapshot }));
    } catch (error: any) {
      return recordingErrorResult(error);
    }
  }

  if (id === "recording_governance.sink.health") {
    if (!hasConsoleScope(context, "recording:read")) {
      return result(403, {
        code: "recording_read_scope_required",
        error: "Reading recording sink health requires recording:read."
      });
    }
    const tenant = effectiveTenant(context, input);
    if (tenant.error) return tenant.error;
    try {
      const health = provider.sinkHealth({
        tenantId: tenant.tenantId,
        integrity: input.integrity === true || input.integrity === "true"
      });
      return result(200, protocolPayload({ health }));
    } catch (error: any) {
      return recordingErrorResult(error);
    }
  }

  if (id === "recording_governance.policy.publish") {
    if (!hasConsoleScope(context, "recording:admin")) {
      return result(403, {
        code: "recording_admin_scope_required",
        error: "Publishing a recording policy revision requires recording:admin."
      });
    }
    const tenant = effectiveTenant(context, input);
    if (tenant.error) return tenant.error;
    const subject = subjectFromAuthSession(context.authSession);
    const configurerRole = String(subject.roleId || "").trim();
    if (!configurerRole) {
      return result(403, {
        code: "recording_policy_change_denied",
        error: "The authenticated session has no configurer role for the recording policy."
      });
    }
    try {
      const published = provider.publishPolicy({
        tenantId: tenant.tenantId,
        expectedRevision: input.expectedRevision,
        policy: input.policy,
        configurerRole
      });
      return result(200, protocolPayload({ published }));
    } catch (error: any) {
      return recordingErrorResult(error);
    }
  }

  return null;
}
