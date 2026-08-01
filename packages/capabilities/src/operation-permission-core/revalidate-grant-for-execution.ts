export function revalidateGrantForExecution({
  store,
  capturedGrant,
  request,
  requiredScopes = [],
  tool = null,
  context = {}
}: Record<string, any> = {}) : any {
  if (!store || typeof store.authorizeGrantForExecution !== "function") {
    return {
      ok: false,
      status: 503,
      error: "Canonical execution grant revalidator is unavailable.",
      reasonCode: "execution_grant_revalidator_unavailable"
    };
  }
  const grantId: any = String(capturedGrant?.id || "");
  const projectionFingerprint: any = String(capturedGrant?.projectionFingerprint || "");
  if (!grantId || !projectionFingerprint) {
    return {
      ok: false,
      status: 403,
      error: "Captured execution grant binding is incomplete.",
      reasonCode: "execution_grant_binding_incomplete"
    };
  }
  return store.authorizeGrantForExecution({
    grantId,
    expectedProjectionFingerprint: projectionFingerprint,
    request,
    requiredScopes,
    tool,
    context
  });
}
