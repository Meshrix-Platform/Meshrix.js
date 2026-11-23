import { sendJson } from "#meshrix/http-utils";

const MANAGED_DEVICE_CREDENTIAL_HEADER = "x-meshrix-device-credential";

function parseJsonBody(requestBody?: any): any {
  if (!requestBody) return {};
  const text = Buffer.isBuffer(requestBody)
    ? requestBody.toString("utf8")
    : String(requestBody || "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error: any = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    error.code = "managed_body_invalid";
    throw error;
  }
}

function publicFailure(error: any) {
  const codes: Record<string, number> = {
    managed_actor_invalid: 400, managed_capability_invalid: 400, managed_endpoint_invalid: 400,
    managed_task_request_invalid: 400, managed_task_outcome_invalid: 400, managed_body_invalid: 400,
    managed_endpoint_label_invalid: 400, managed_endpoint_kind_invalid: 400,
    managed_capability_set_invalid: 400, managed_capability_schema_invalid: 400,
    managed_task_input_invalid: 400, managed_permission_invalid: 400,
    managed_event_invalid: 400, managed_event_batch_invalid: 400,
    managed_workspace_invalid: 400, managed_workspace_set_invalid: 400,
    managed_signature_invalid: 400, managed_signature_policy_invalid: 400,
    managed_organization_required: 403, managed_tenant_required: 403, managed_subject_required: 403,
    managed_device_credential_invalid: 403, managed_enrollment_token_invalid: 403,
    managed_enrollment_token_expired: 403, managed_enrollment_rebind_rejected: 403,
    managed_device_authority_required: 403, managed_authority_required: 403, managed_authority_denied: 403,
    managed_endpoint_not_found: 404, managed_organization_forbidden: 404,
    managed_capability_unpublished: 404, managed_capability_unavailable: 404,
    managed_workspace_unavailable: 404,
    managed_task_not_found: 404, managed_permission_not_found: 404,
    managed_capability_not_allowed: 403, managed_endpoint_revoked: 409,
    managed_request_conflict: 409, managed_admission_incomplete: 409,
    managed_capability_revision_conflict: 409, managed_catalog_conflict: 409, managed_permission_conflict: 409,
    managed_permission_option_invalid: 409, managed_task_not_running: 409,
    managed_lease_conflict: 409, managed_task_outcome_conflict: 409,
    managed_event_seq_conflict: 409, managed_event_overflow: 409,
    managed_task_cancelled: 409, managed_endpoint_capacity_exceeded: 429
  };
  const code = Object.hasOwn(codes, error?.code) ? error.code : "managed_internal_error";
  const status = codes[code] || 500;
  return { status, code, error: status === 500 ? "Managed endpoint request failed." : "Managed endpoint request was rejected." };
}

function respondError(response: any, error: any): void {
  const { status, ...body } = publicFailure(error);
  sendJson(response, status, body);
}

function memberInput(input: Record<string, unknown>) {
  const business = { ...input };
  const confirmation: Record<string, unknown> = {};
  for (const key of ["confirm", "safetyConfirm", "safety"]) {
    if (Object.hasOwn(business, key)) {
      confirmation[key] = business[key];
      delete business[key];
    }
  }
  return { business, confirmation };
}

function deviceCredentialFromRequest(request: any): string {
  const header = request?.headers?.[MANAGED_DEVICE_CREDENTIAL_HEADER] ??
    request?.headers?.[MANAGED_DEVICE_CREDENTIAL_HEADER.toLowerCase()];
  return typeof header === "string" ? header : "";
}

function deviceActor(device: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "managed-device",
    userId: device.endpointId,
    subjectId: device.endpointId,
    roleId: "managed-device",
    tenantId: device.tenantId,
    orgId: device.organizationId,
    organizationId: device.organizationId,
    endpointId: device.endpointId,
    scopes: []
  };
}

export function createManagedEndpointsController({
  managedEndpointService,
  actorFromSession = null
}: Record<string, any> = {}): any {
  if (!managedEndpointService) {
    throw new Error("Managed endpoints controller requires managedEndpointService.");
  }
  if (typeof actorFromSession !== "function") {
    throw new Error("Managed endpoints controller requires actorFromSession.");
  }

  // Device worker authority: only the durable device credential is accepted,
  // only on worker routes, and only to authenticate tenant/org/device fields.
  // Request JSON can never supply or override that identity.
  async function verifyManagedEndpointWorkerAuth({ request }: Record<string, any> = {}): Promise<any> {
    try {
      const device = await managedEndpointService.verifyWorker(
        deviceCredentialFromRequest(request)
      );
      const actor = deviceActor(device);
      return {
        ok: true,
        actor,
        authSession: {
          user: { ...actor, managedEndpoint: device.endpoint },
          revalidateManagedDevice: () => managedEndpointService.verifyWorker(deviceCredentialFromRequest(request))
        },
        managedDevice: device,
        revalidateAuthorization: async (): Promise<any> => {
          try {
            const current = await managedEndpointService.verifyWorker(
              deviceCredentialFromRequest(request), { observe: false }
            );
            if (current.endpointId !== device.endpointId) {
              return {
                ok: false,
                status: 403,
                reasonCode: "managed_device_credential_stale",
                error: "Managed device credential is no longer authorized."
              };
            }
            return { ok: true, managedDevice: current };
          } catch (error: any) {
            const failure = publicFailure(error);
            return {
              ok: false,
              status: failure.status,
              reasonCode: failure.code,
              error: failure.error
            };
          }
        }
      };
    } catch (error: any) {
      const failure = publicFailure(error);
      return {
        ok: false,
        status: failure.status,
        reasonCode: failure.code,
        error: failure.error
      };
    }
  }

  // Bind token authority to the current endpoint before dispatch and recheck
  // at the protected effect. Token consumption remains atomic in enrollment.
  async function verifyManagedEndpointEnrollmentAuth({ requestBody, input }: Record<string, any> = {}): Promise<any> {
    try {
      const body = input === undefined ? parseJsonBody(requestBody) : input;
      const binding = managedEndpointService.verifyEnrollment(body);
      const actor = { ...deviceActor(binding), type: "managed-enrollment", roleId: "managed-enrollment" };
      return {
        ok: true, actor, authSession: { user: actor },
        revalidateAuthorization: async () => {
          try {
            const current = managedEndpointService.verifyEnrollment(body);
            return { ok: current.endpointId === binding.endpointId && current.generation === binding.generation };
          } catch (error) {
            const failure = publicFailure(error);
            return { ok: false, status: failure.status, reasonCode: failure.code, error: failure.error };
          }
        }
      };
    } catch (error: any) {
      const failure = publicFailure(error);
      return {
        ok: false,
        status: failure.status,
        reasonCode: failure.code,
        error: failure.error
      };
    }
  }

  async function deviceFromAuth(authSession: any): Promise<Record<string, unknown>> {
    const user = authSession?.user || {};
    if (user.type !== "managed-device" || !user.endpointId || !user.managedEndpoint) {
      const error: any = new Error("Managed device authority is required.");
      error.statusCode = 403;
      error.code = "managed_device_authority_required";
      throw error;
    }
    // The verifier already authenticated the credential for this request;
    // the durable endpoint record travels inside the session authority.
    if (typeof authSession.revalidateManagedDevice !== "function") {
      throw Object.assign(new Error("Managed device authority is required."), {
        code: "managed_device_authority_required", statusCode: 403
      });
    }
    return authSession.revalidateManagedDevice();
  }

  async function handle(handler: (args: Record<string, any>) => Promise<any>, args: Record<string, any>): Promise<any> {
    const { response } = args;
    try {
      const input = args.input === undefined ? parseJsonBody(args.requestBody) : args.input;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw Object.assign(new Error("Managed input must be an object."), { code: "managed_body_invalid" });
      }
      return await handler({ ...args, input });
    } catch (error: any) {
      return respondError(response, error);
    }
  }

  const controller: Record<string, any> = {
    projectErrorResponse({ status, payload }: { status: number; payload: Record<string, unknown> }) {
      const supplied = payload?.code || payload?.reasonCode;
      const code = typeof supplied === "string" && supplied.startsWith("managed_") ? supplied
        : status >= 500 ? "managed_internal_error" : status === 400 ? "managed_body_invalid" : "managed_authority_denied";
      const failure = publicFailure({ code, statusCode: status });
      return { status: failure.status, body: { code: failure.code, error: failure.error } };
    },
    verifyManagedEndpointWorkerAuth,
    verifyManagedEndpointEnrollmentAuth,

    handleEnroll: (args: Record<string, any>) => handle(async ({ input, response }) => {
      const enrolled = await managedEndpointService.enroll(input);
      sendJson(response, 200, enrolled);
    }, args),

    handleWorkerCatalog: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerCatalog(device, input));
    }, args),

    handleWorkerPoll: (args: Record<string, any>) => handle(async ({ input, response, authSession, signal }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerPoll(device, input, { signal }));
    }, args),

    handleWorkerStart: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerStart(device, input));
    }, args),

    handleWorkerEvent: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerEvent(device, input));
    }, args),

    handleWorkerPermission: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerPermission(device, input));
    }, args),

    handleWorkerComplete: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerComplete(device, input));
    }, args),

    handleWorkerSignaturePolicy: (args: Record<string, any>) => handle(async ({ response, authSession }) => {
      const device = await deviceFromAuth(authSession);
      sendJson(response, 200, await managedEndpointService.workerSignaturePolicy(device));
    }, args),

    handleListEndpoints: (args: Record<string, any>) => handle(async ({ response, authSession }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.listEndpoints(actor));
    }, args),

    handleCreateEndpoint: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 201, await managedEndpointService.createEndpoint(actor, memberInput(input).business));
    }, args),

    handleUpdateEndpoint: (args: Record<string, any>) => handle(async ({ input, response, authSession, endpointId }) => {
      const actor = await actorFromSession(authSession);
      const { endpointId: selectedId, ...body } = memberInput(input).business;
      sendJson(response, 200, await managedEndpointService.updateEndpoint(actor, selectedId ?? endpointId, body));
    }, args),

    handleRevokeEndpoint: (args: Record<string, any>) => handle(async ({ input, response, authSession, endpointId }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.revokeEndpoint(actor, input.endpointId ?? endpointId));
    }, args),

    handleSubmitTask: (args: Record<string, any>) => handle(async ({ request, response, authSession, input, operation, operationLock }) => {
      const actor = await actorFromSession(authSession);
      const { business, confirmation } = memberInput(input);
      const result = await managedEndpointService.submitTask(actor, business, {
        request, authSession, operation, operationLock, confirmation,
        onProofReplay: (disposition: "existing" | "rejected") => {
          response.__meshrixOperationProofReplay = {
            intentId: request.__meshrixOperationProof.pactium.intentId,
            disposition
          };
        }
      });
      response.__meshrixOperationProofResult = { taskId: result.task.taskId };
      sendJson(response, 202, result);
    }, args),

    handleGetTask: (args: Record<string, any>) => handle(async ({ input, response, authSession, taskId }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.getTask(actor, input.taskId ?? taskId));
    }, args),

    handleTaskEvents: (args: Record<string, any>) => handle(async ({ input, response, authSession, taskId, signal }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.taskEvents(
        actor, input.taskId ?? taskId, input, { signal }
      ));
    }, args),

    handleCancelTask: (args: Record<string, any>) => handle(async ({ input, response, authSession, taskId }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.cancelTask(actor, input.taskId ?? taskId));
    }, args),

    handleTaskPermission: (args: Record<string, any>) => handle(async ({ response, authSession, taskId, input }) => {
      const actor = await actorFromSession(authSession);
      const { taskId: selectedId, ...body } = memberInput(input).business;
      sendJson(response, 200, await managedEndpointService.resolvePermission(actor, selectedId ?? taskId, body));
    }, args),

    handleSetSignaturePolicy: (args: Record<string, any>) => handle(async ({ input, response, authSession }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.setSignaturePolicy(actor, memberInput(input).business));
    }, args),

    handleGetSignaturePolicy: (args: Record<string, any>) => handle(async ({ response, authSession }) => {
      const actor = await actorFromSession(authSession);
      sendJson(response, 200, await managedEndpointService.getSignaturePolicy(actor));
    }, args)
  };

  return controller;
}
