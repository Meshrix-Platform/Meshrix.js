function ownerScope(input = {}) {
  const ownerId = String(input.ownerId || "").trim();
  const ownerGenerationDigest = String(input.ownerGenerationDigest || "").trim();
  const ownerGeneration = Number(input.ownerGeneration);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new TypeError("Plugin owner process identity scope is invalid.");
  }
  return Object.freeze({ ownerId, ownerGenerationDigest, ownerGeneration });
}

function unavailable() {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "owner_process_identity_host_unavailable", retryable: true })
  });
}

function lifecycleAuthority(input = {}) {
  const port = input.lifecycleStatePort;
  if (port?.id !== "PluginLifecycleStatePort" || typeof port.readRecord !== "function" ||
      typeof port.runExclusive !== "function") {
    throw new TypeError("Plugin owner process identity lifecycle authority is invalid.");
  }
  return port;
}

async function admitActive(port, scope, task) {
  return port.runExclusive(async () => {
    const ledger = await port.readRecord("ledger");
    if (!ledger || ledger.pluginId !== scope.ownerId || ledger.state !== "active" || ledger.generation !== scope.ownerGeneration) {
      return Object.freeze({
        ok: false,
        reasonCode: "owner_process_binding_generation_retired",
        error: Object.freeze({ code: "owner_process_binding_generation_retired", retryable: false })
      });
    }
    return task();
  });
}

export function createPluginOwnerProcessIdentityAuthority({ invocationAuthorizationAuthority = null } = {}) {
  let authority = null;
  let closed = false;
  return Object.freeze({
    id: "PluginOwnerProcessIdentityAuthority",
    bind(next) {
      const methods = [
        "issueOwnerProcessBinding", "inspectOwnerProcessBinding", "revokeOwnerProcessBinding",
        "revokeOwnerProcessBindings", "verifyOwnerProcessBindingsRevoked"
      ];
      if (closed || authority || methods.some((method) => typeof next?.[method] !== "function")) {
        throw new TypeError("Plugin owner process identity authority cannot be bound.");
      }
      authority = next;
    },
    forOwner(input = {}) {
      const scope = ownerScope(input);
      const lifecycleStatePort = lifecycleAuthority(input);
      if (invocationAuthorizationAuthority?.id !== "PluginInvocationAuthorizationAuthority") {
        throw new TypeError("Plugin invocation authorization authority is unavailable.");
      }
      invocationAuthorizationAuthority.registerOwner({ ...scope, lifecycleStatePort });
      const call = (method, request = {}) => authority
        ? authority[method](Object.freeze({ ...request, ...scope }))
        : Promise.resolve(unavailable());
      return Object.freeze({
        id: "OwnerProcessIdentityHostPort",
        ownerGenerationDigest: scope.ownerGenerationDigest,
        ownerGeneration: scope.ownerGeneration,
        issueBinding: (request = {}) => admitActive(
          lifecycleStatePort,
          scope,
          async () => {
            const claims = await invocationAuthorizationAuthority.verify(request.invocationAuthorization, {
              ...scope,
              audience: "owner-process-identity",
              operationId: request.invocationOperationId,
              targetRef: request.targetRef
            });
            return call("issueOwnerProcessBinding", {
              targetRef: request.targetRef,
              identityContext: Object.freeze({
                subject: claims.principal.subjectRef,
                tenant: claims.principal.tenantRef,
                workspace: claims.principal.workspaceRef,
                target: request.targetRef,
                operation: claims.operationId,
                grant: claims.governance.grantRef,
                approval: claims.governance.approvalRef,
                risk: claims.governance.riskDecisionRef,
                policyRevision: claims.governance.policyRevision,
                authorized: true,
                current: true,
                revoked: false,
                correlation: claims.requestRef
              }),
              idempotencyKey: request.idempotencyKey,
              deadline: request.deadline
            });
          }
        ),
        inspectBinding: (request) => call("inspectOwnerProcessBinding", request),
        revokeBinding: (request) => call("revokeOwnerProcessBinding", request),
        revokeAllBindings: () => call("revokeOwnerProcessBindings"),
        verifyNoBindings: () => call("verifyOwnerProcessBindingsRevoked")
      });
    },
    close() {
      closed = true;
      authority = null;
    }
  });
}
