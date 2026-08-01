function requiredFunction(name?: any, value?: any) : any {
  if (typeof value !== "function") {
    throw new Error(`Upstream gateway executor requires ${name}.`);
  }
  return value;
}

const CONFIG_MUTATION_OPERATION_IDS: any = new Set<any>([
  "external_services.create",
  "external_services.replace",
  "external_services.disable",
  "external_services.remove",
  "external_services.republish"
]);

const CONFIG_MUTATION_ACTIONS: Readonly<Record<string, any>> = Object.freeze({
  "external_services.create": "create",
  "external_services.replace": "replace",
  "external_services.disable": "disable",
  "external_services.remove": "remove",
  "external_services.republish": "republish"
});

export function createUpstreamGatewayOperationExecutor(dependencies: Record<string, any> = {}) : any {
  const errorPayload: any = requiredFunction("errorPayload", dependencies.errorPayload);
  const objectOrNull: any = requiredFunction("objectOrNull", dependencies.objectOrNull);
  const protocolPayload: any = requiredFunction("protocolPayload", dependencies.protocolPayload);
  const result: any = requiredFunction("result", dependencies.result);
  const subjectFromAuthSession: any = requiredFunction("subjectFromAuthSession", dependencies.subjectFromAuthSession);
  const upstreamGatewayRegistryFor: any = requiredFunction("upstreamGatewayRegistryFor", dependencies.upstreamGatewayRegistryFor);

  function upstreamGatewayServiceId(input: Record<string, any> = {}, context: Record<string, any> = {}) : any {
    return String(
      context.serviceId ||
        input.serviceId ||
        input["service-id"] ||
        input.id ||
        input.upstreamId ||
        input["upstream-id"] ||
        ""
    ).trim();
  }

  return async function executeUpstreamGatewayOperation({ operationId, input = {}, context = {} }: Record<string, any>) : Promise<any> {
    const id: any = String(operationId || "");
    if (
      !id.startsWith("gateway.") &&
      !id.startsWith("external_services.") &&
      !id.startsWith("upstream_operation.")
    ) {
      return null;
    }
    const registry: any = upstreamGatewayRegistryFor(context);
    const authSubject: any = subjectFromAuthSession(context.authSession);
    const runtimeSubject: any = objectOrNull(context.subject) || {};
    const subject: Record<string, any> = {
      ...authSubject,
      ...runtimeSubject,
      subjectId: runtimeSubject.subjectId || runtimeSubject.id || authSubject.subjectId || "",
      username: runtimeSubject.username || authSubject.username || runtimeSubject.label || "",
      scopes: Array.isArray(runtimeSubject.scopes) ? runtimeSubject.scopes : authSubject.scopes,
      approvedPendingOperation: context.request?.__meshrixToolRuntimeAuthorization?.approvedPendingOperation || null
    };

    try {
      if (id === "external_services.publications.list") {
        return result(200, protocolPayload(await context.upstreamPublishingApplication.list(subject, {
          signal: context.signal || null
        })));
      }
      if (id === "external_services.publications.get") {
        return result(200, protocolPayload(await context.upstreamPublishingApplication.get(
          upstreamGatewayServiceId(input, context),
          subject,
          { signal: context.signal || null }
        )));
      }
      if (CONFIG_MUTATION_OPERATION_IDS.has(id)) {
        if (!context.upstreamPublishingApplication?.execute || !context.rawRequestBody) {
          return result(503, errorPayload(new Error("Upstream publishing application is unavailable."), "Upstream publishing failed."));
        }
        const published: any = await context.upstreamPublishingApplication.execute(context.rawRequestBody, subject, {
          signal: context.signal || null,
          expectedAction: CONFIG_MUTATION_ACTIONS[id],
          expectedServiceId: upstreamGatewayServiceId(input, context)
        });
        return result(202, protocolPayload(published));
      }
      if (id === "external_services.list") {
        return result(200, protocolPayload(registry.listServices(input)));
      }

      const serviceId: any = upstreamGatewayServiceId(input, context);
      if (id.startsWith("external_services.") && !serviceId) {
        return result(400, errorPayload(new Error("Upstream service operation requires serviceId."), "Upstream gateway operation failed."));
      }

      if (id === "external_services.get") {
        return result(200, protocolPayload({ service: registry.getService(serviceId) }));
      }
      if (id === "external_services.health") {
        return result(200, protocolPayload(await registry.health(serviceId)));
      }
      if (id === "gateway.policy.preview") {
        return result(200, protocolPayload(registry.previewPolicy(input, subject)));
      }
      if (id.startsWith("upstream_operation.")) {
        const forward: any = await registry.forwardProjectedOperation(id, input, subject, {
          signal: context.signal || null,
          responseAdapter: context.transport === "mcp" ? "artifact" : "structured",
          finalProtectedSinkPermit: context.finalProtectedSinkPermit || null
        });
        return result(forward.status === "pending_approval" ? 202 : 200, protocolPayload(forward));
      }
      if (id === "gateway.forward") {
        const forward: any = await registry.forward(input, subject, {
          signal: context.signal || null,
          responseAdapter: context.transport === "mcp" ? "artifact" : "structured",
          finalProtectedSinkPermit: context.finalProtectedSinkPermit || null
        });
        return result(forward.status === "pending_approval" ? 202 : 200, protocolPayload(forward));
      }
      if (id === "gateway.audit") {
        return result(200, protocolPayload(registry.listAudit(input)));
      }
      if (id === "gateway.metrics") {
        return result(200, protocolPayload(registry.getMetrics()));
      }
    } catch (error: any) {
      return result(Number(error?.statusCode || error?.status || 400), errorPayload(error, "Upstream gateway operation failed.", {
        details: error?.details || undefined,
        auditId: error?.audit?.auditId || ""
      }));
    }
    return null;
  };
}
