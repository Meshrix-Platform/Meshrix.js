export const AGENT_RUNTIME_PROVIDER_PROTOCOL_VERSION: any = "v0.0.1:agent:runtime-1";

function requireFunction(value?: any, name?: any) : any {
  if (typeof value !== "function") {
    throw new Error(`agent runtime provider is missing ${name}.`);
  }
  return value;
}

export function createAgentRuntimeProvider({
  getAgentConfigRegistry,
  loadAgentGatewayModule,
  loadModelProbeModule,
  loadRuntimeSettings
}: Record<string, any> = {}) : any {
  const registryFactory: any = requireFunction(getAgentConfigRegistry, "getAgentConfigRegistry");
  const gatewayModuleLoader: any = requireFunction(loadAgentGatewayModule, "loadAgentGatewayModule");
  const modelProbeModuleLoader: any = requireFunction(loadModelProbeModule, "loadModelProbeModule");
  const runtimeSettingsLoader: any = requireFunction(loadRuntimeSettings, "loadRuntimeSettings");

  async function loadGatewayModule() : Promise<any> {
    return gatewayModuleLoader();
  }

  async function runtimeSettingsWithModelLibrary(userDataPath?: any) : Promise<any> {
    return runtimeSettingsLoader(userDataPath);
  }

  return Object.freeze({
    protocolVersion: AGENT_RUNTIME_PROVIDER_PROTOCOL_VERSION,
    describe() : any {
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: AGENT_RUNTIME_PROVIDER_PROTOCOL_VERSION,
        capabilities: [
          "agent.settings.read",
          "agent.settings.write",
          "agent.gateway.config",
          "agent.gateway.call",
          "agent.gateway.registry",
          "agent.model.probe",
          "agent.model.routing.health"
        ]
      };
    },
    getAgentConfigRegistry() : any {
      return registryFactory();
    },
    async loadAgentGatewayModule() : Promise<any> {
      return loadGatewayModule();
    },
    async publicAgentGatewayConfig(settings: Record<string, any> = {}, input: Record<string, any> = {}) : Promise<any> {
      const { publicAgentGatewayConfig } = await loadGatewayModule();
      return publicAgentGatewayConfig(settings, input);
    },
    async publicAgentGatewayRegistry(settings: Record<string, any> = {}) : Promise<any> {
      const { publicAgentGatewayRegistry } = await loadGatewayModule();
      return publicAgentGatewayRegistry(settings);
    },
    async callAgentGateway(input: Record<string, any> = {}) : Promise<any> {
      const { callAgentGateway } = await loadGatewayModule();
      return callAgentGateway(input);
    },
    async callGatewayWithRuntimeSettings({
      userDataPath,
      input,
      contextRuntime = null,
      contextCompactionSource = ""
    }: Record<string, any> = {}) : Promise<any> {
      return this.callAgentGateway({
        settings: await runtimeSettingsWithModelLibrary(userDataPath),
        input,
        userDataPath,
        contextRuntime,
        contextCompactionSource
      });
    },
    async probeModelConnection(input: Record<string, any> = {}) : Promise<any> {
      const { probeModelConnection } = await modelProbeModuleLoader();
      return probeModelConnection(input);
    },
    async inspectAgentModelRouting(input: Record<string, any> = {}) : Promise<any> {
      const { inspectAgentModelRouting } = await loadGatewayModule();
      return inspectAgentModelRouting(input);
    }
  });
}
