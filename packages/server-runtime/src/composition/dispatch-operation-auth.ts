import { getRuntimeLogger, summarizeError } from "#meshrix/foundation/observability/runtime-logger";
import { externalAuthVerifierConfig, logOperation } from "./dispatch-operation-support.ts";

export async function verifyExternalAuth({
  operation,
  controllers,
  request,
  input,
  requestBody,
  url,
  params,
  method,
  transport,
  phase = ""
}: Record<string, any>) : Promise<any> {
  const verifierConfig: any = externalAuthVerifierConfig(operation);
  const controllerName: any = verifierConfig.controller || operation.target?.controller || "";
  const methodName: any = verifierConfig.method || "";
  const verifier: any = controllers?.[controllerName]?.[methodName];
  if (typeof verifier !== "function") {
    return {
      ok: false,
      status: 503,
      reasonCode: "external_auth_verifier_missing",
      error: "External authentication verifier is not registered."
    };
  }

  try {
    const verification: any = await verifier({
      operation,
      request,
      input,
      requestBody,
      url,
      params,
      method,
      transport,
      phase,
      externalAuth: verifierConfig
    });
    if (verification === true) {
      return { ok: true };
    }
    if (verification?.ok === true) {
      return verification;
    }
    return {
      ok: false,
      status: Number(verification?.status || verification?.statusCode || 401) || 401,
      reasonCode: verification?.reasonCode || verification?.code || "external_auth_denied",
      error: verification?.error || verification?.message || "External authentication denied.",
      missingScopes: verification?.missingScopes || [],
      missingCapabilities: verification?.missingCapabilities || []
    };
  } catch (error: any) {
    logOperation(getRuntimeLogger(), "error", "operation.external_auth.verifier_failed", {
      operationId: operation.id,
      verifier: `${controllerName}.${methodName}`,
      error: summarizeError(error)
    });
    return {
      ok: false,
      status: 503,
      reasonCode: "external_auth_verifier_failed",
      error: "External authentication verifier failed."
    };
  }
}
