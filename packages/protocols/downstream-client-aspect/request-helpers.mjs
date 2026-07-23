import {
  DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.mjs";
import { asText, cloneJson, lowerToken } from "./identity-helpers.mjs";

export function translateDownstreamClientInboundRequest(service, { protocol = "", method = "", input = {}, context = {}, frameworkId = "" } = {}) {
  const normalizedProtocol = lowerToken(protocol);
  const routeTarget = DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS[normalizedProtocol];
  if (!routeTarget) {
    return Object.freeze({
      ok: false,
      serviceKind: DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND,
      protocol: normalizedProtocol,
      reasonCode: "downstream_protocol_not_supported"
    });
  }

  const candidate = service.listCapabilities({
    protocol: normalizedProtocol,
    frameworkId,
    includeUnavailable: true
  }).find((record) => !frameworkId || record.frameworkId === lowerToken(frameworkId));

  return Object.freeze({
    ok: true,
    serviceKind: DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND,
    protocol: normalizedProtocol,
    routeTarget,
    routeIntent: {
      routeTarget,
      method: asText(method),
      input: cloneJson(input),
      context: cloneJson(context),
      frameworkId: lowerToken(frameworkId),
      adapterId: candidate?.adapterId || "",
      profileId: candidate?.profileId || ""
    },
    executionBoundary: "translate-only",
    authorizationBoundary: "platform-service",
    operationBoundary: "v0.0.1:operation-permission:projection-1"
  });
}
