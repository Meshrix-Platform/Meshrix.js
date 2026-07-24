import { createDownstreamClientAspectService } from "../../../protocols/downstream-client-aspect/index.mjs";

function ownerScope(input = {}) {
  const ownerId = String(input.ownerId || "").trim();
  const ownerGenerationDigest = String(input.ownerGenerationDigest || "").trim();
  const ownerGeneration = Number(input.ownerGeneration);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !/^[a-f0-9]{64}$/u.test(ownerGenerationDigest) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new TypeError("Plugin downstream client aspect scope is invalid.");
  }
  const lifecycleStatePort = input.lifecycleStatePort;
  if (lifecycleStatePort?.id !== "PluginLifecycleStatePort" || typeof lifecycleStatePort.readRecord !== "function" ||
      typeof lifecycleStatePort.runExclusive !== "function") {
    throw new TypeError("Downstream client aspect owner lifecycle binding is required.");
  }
  return Object.freeze({ ownerId, ownerGenerationDigest, ownerGeneration, lifecycleStatePort });
}

function admitActive(scope, task) {
  return scope.lifecycleStatePort.runExclusive(async () => {
    const ledger = await scope.lifecycleStatePort.readRecord("ledger");
    if (!ledger || ledger.pluginId !== scope.ownerId || ledger.state !== "active" || ledger.generation !== scope.ownerGeneration) {
      const error = new Error("Plugin downstream client aspect owner generation is not active.");
      error.code = "plugin_downstream_client_aspect_owner_retired";
      throw error;
    }
    return task();
  });
}

export function createPluginDownstreamClientAspectAuthority({ createService = createDownstreamClientAspectService } = {}) {
  if (typeof createService !== "function") throw new TypeError("Downstream client aspect service factory is required.");
  return Object.freeze({
    id: "PluginDownstreamClientAspectAuthority",
    forOwner({ configuration = {}, ...input } = {}) {
      const scope = ownerScope(input);
      if (configuration?.enabled !== true || configuration?.start !== true ||
          !configuration.startOptions || typeof configuration.startOptions !== "object" || Array.isArray(configuration.startOptions)) {
        throw new TypeError("Downstream client aspect Host capability requires explicit enablement and start configuration.");
      }
      return Object.freeze({
        id: "DownstreamClientAspectHostPort",
        ownerGenerationDigest: scope.ownerGenerationDigest,
        ownerGeneration: scope.ownerGeneration,
        create({ logger = null } = {}) {
          return admitActive(scope, () => {
            const service = createService({
              frameworkOverrides: [],
              env: configuration.env && typeof configuration.env === "object" ? configuration.env : {},
              logger
            });
            service.start(configuration.startOptions);
            let stopped = false;
            const activeCall = (task) => {
              if (stopped) {
                const error = new Error("Plugin downstream client aspect service is stopped.");
                error.code = "plugin_downstream_client_aspect_stopped";
                throw error;
              }
              return admitActive(scope, task);
            };
            return Object.freeze({
              isStarted: () => activeCall(() => service.started === true),
              listCapabilities: (request) => activeCall(() => service.listCapabilities(request)),
              listProtocolLayers: () => activeCall(() => service.listProtocolLayers()),
              summary: () => activeCall(() => service.summary()),
              translateInboundRequest: (request) => activeCall(() => service.translateInboundRequest(request)),
              start: (request = {}) => activeCall(() => service.start({
                ...configuration.startOptions,
                ...(request.now instanceof Date ? { now: request.now } : {})
              })),
              stop: async () => {
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
