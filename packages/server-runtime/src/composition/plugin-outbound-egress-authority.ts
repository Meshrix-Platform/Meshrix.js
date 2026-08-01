import { classifyOutboundHost } from "#meshrix/foundation/security/outbound-egress-policy";

export function createPluginOutboundEgressAuthority() : any {
  return Object.freeze({
    id: "PluginOutboundEgressAuthority",
    forOwner({ ownerId, ownerGenerationDigest, ownerGeneration, lifecycleStatePort }: Record<string, any> = {}) : any {
      const id: any = String(ownerId || "").trim();
      const generation: any = String(ownerGenerationDigest || "").trim();
      const generationNumber: any = Number(ownerGeneration);
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(generation) ||
          !Number.isSafeInteger(generationNumber) || generationNumber < 1 ||
          lifecycleStatePort?.id !== "PluginLifecycleStatePort" || typeof lifecycleStatePort?.readRecord !== "function" ||
          typeof lifecycleStatePort?.runExclusive !== "function") {
        throw new TypeError("Outbound egress owner lifecycle binding is required.");
      }
      return Object.freeze({
        id: "OutboundEgressHostPort",
        ownerGenerationDigest: generation,
        ownerGeneration: generationNumber,
        async classifyHost(host?: any) : Promise<any> {
          return lifecycleStatePort.runExclusive(async () : Promise<any> => {
            const ledger: any = await lifecycleStatePort.readRecord("ledger");
            if (!ledger || ledger.pluginId !== id || ledger.state !== "active" || ledger.generation !== generationNumber) {
              const error: Error & Record<string, any> = new Error("Plugin outbound egress owner generation is not active.");
              error.code = "plugin_outbound_egress_owner_retired";
              throw error;
            }
            return classifyOutboundHost(host);
          });
        }
      });
    }
  });
}
