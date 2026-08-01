import { createDownstreamClientAspectService } from "#meshrix/protocols/downstream-client-aspect/index";

function ownerScope(input: Record<string, any> = {}) : any {
  const ownerId: any = String(input.ownerId || "").trim();
  const ownerGenerationDigest: any = String(input.ownerGenerationDigest || "").trim();
  const ownerGeneration: any = Number(input.ownerGeneration);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new TypeError("Plugin downstream client aspect scope is invalid.");
  }
  const lifecycleStatePort: any = input.lifecycleStatePort;
  if (lifecycleStatePort?.id !== "PluginLifecycleStatePort" || typeof lifecycleStatePort.readRecord !== "function" ||
      typeof lifecycleStatePort.runExclusive !== "function") {
    throw new TypeError("Downstream client aspect owner lifecycle binding is required.");
  }
  return Object.freeze({ ownerId, ownerGenerationDigest, ownerGeneration, lifecycleStatePort });
}

function admitActive(scope?: any, task?: any) : any {
  return scope.lifecycleStatePort.runExclusive(async () : Promise<any> => {
    const ledger: any = await scope.lifecycleStatePort.readRecord("ledger");
    if (!ledger || ledger.pluginId !== scope.ownerId || ledger.state !== "active" || ledger.generation !== scope.ownerGeneration) {
      const error: Error & Record<string, any> = new Error("Plugin downstream client aspect owner generation is not active.");
      error.code = "plugin_downstream_client_aspect_owner_retired";
      throw error;
    }
    return task();
  });
}

export function createPluginDownstreamClientAspectAuthority({ createService = createDownstreamClientAspectService }: Record<string, any> = {}) : any {
  if (typeof createService !== "function") throw new TypeError("Downstream client aspect service factory is required.");
  return Object.freeze({
    id: "PluginDownstreamClientAspectAuthority",
    forOwner({ configuration = {}, ...input }: Record<string, any> = {}) : any {
      const scope: any = ownerScope(input);
      if (configuration?.enabled !== true || configuration?.start !== true ||
          !configuration.startOptions || typeof configuration.startOptions !== "object" || Array.isArray(configuration.startOptions)) {
        throw new TypeError("Downstream client aspect Host capability requires explicit enablement and start configuration.");
      }
      return Object.freeze({
        id: "DownstreamClientAspectHostPort",
        ownerGenerationDigest: scope.ownerGenerationDigest,
        ownerGeneration: scope.ownerGeneration,
        create({ logger = null }: Record<string, any> = {}) : any {
          return admitActive(scope, () : any => {
            const service: any = createService({
              frameworkOverrides: [],
              env: configuration.env && typeof configuration.env === "object" ? configuration.env : {},
              logger
            });
            service.start(configuration.startOptions);
            let stopped: any = false;
            const activeCall: any = (task?: any) : any => {
              if (stopped) {
                const error: Error & Record<string, any> = new Error("Plugin downstream client aspect service is stopped.");
                error.code = "plugin_downstream_client_aspect_stopped";
                throw error;
              }
              return admitActive(scope, task);
            };
            return Object.freeze({
              isStarted: () : any => activeCall(() : any => service.started === true),
              listCapabilities: (request?: any) : any => activeCall(() : any => service.listCapabilities(request)),
              listProtocolLayers: () : any => activeCall(() : any => service.listProtocolLayers()),
              summary: () : any => activeCall(() : any => service.summary()),
              translateInboundRequest: (request?: any) : any => activeCall(() : any => service.translateInboundRequest(request)),
              start: (request: Record<string, any> = {}) : any => activeCall(() : any => service.start({
                ...configuration.startOptions,
                ...(request.now instanceof Date ? { now: request.now } : {})
              })),
              stop: async () : Promise<any> => {
                if (stopped) return Object.freeze({ ok: true, alreadyStopped: true });
                stopped = true;
                return service.stop();
              }
            });
          });
        }
      });
    }
  });
}
