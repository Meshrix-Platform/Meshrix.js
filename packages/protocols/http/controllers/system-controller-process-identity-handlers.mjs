import { sendJson } from "#meshrix/http-utils";

function parseBody(parseJsonBody, requestBody) {
  try {
    return requestBody?.length > 0 ? parseJsonBody(requestBody) : {};
  } catch {
    return {};
  }
}

function unavailable(response) {
  sendJson(response, 503, {
    ok: false,
    reasonCode: "process_identity_unavailable",
    error: "Process identity service is unavailable."
  });
}

export function createSystemControllerProcessIdentityHandlers({
  parseJsonBody,
  processIdentity = null
}) {
  return {
    async handleProcessIdentityBootstrapClaim({ request, requestBody, response }) {
      if (!processIdentity?.bootstrapClaim) {
        unavailable(response);
        return;
      }
      const result = await processIdentity.bootstrapClaim({
        request,
        input: parseBody(parseJsonBody, requestBody)
      });
      sendJson(response, result.status || (result.ok ? 200 : 400), result);
    },

    async handleProcessIdentityPackageRotate({ request, requestBody, response }) {
      if (!processIdentity?.rotateClientIdentityPackage) {
        unavailable(response);
        return;
      }
      const result = await processIdentity.rotateClientIdentityPackage({
        request,
        input: parseBody(parseJsonBody, requestBody)
      });
      sendJson(response, result.status || (result.ok ? 200 : 400), result);
    },

    async handleProcessIdentityPackageRevoke({ request, requestBody, response }) {
      if (!processIdentity?.revokeClientIdentityPackage) {
        unavailable(response);
        return;
      }
      const result = await processIdentity.revokeClientIdentityPackage({
        request,
        input: parseBody(parseJsonBody, requestBody)
      });
      sendJson(response, result.status || (result.ok ? 200 : 400), result);
    }
  };
}
