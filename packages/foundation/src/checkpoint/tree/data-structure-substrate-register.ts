// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerDataStructureSubstratePlatformServices(registry?: any, {
  dataStructureSubstrate = null,
  registerPlatformService = null
}: Record<string, any> = {}) : any {
  const register: any = typeof registerPlatformService === "function"
    ? registerPlatformService
    : (targetRegistry?: any, entry?: any) : any => {
        if (!targetRegistry || typeof targetRegistry.register !== "function") {
          throw new Error("A PlatformRegistry instance is required.");
        }
        return targetRegistry.register(entry);
      };
  const checkpointTreeProjection: any = dataStructureSubstrate?.checkpointTreeProjection || null;
  const merkleStateSubstrate: any = dataStructureSubstrate?.merkleStateSubstrate || null;
  const textNormalizationSubstrate: any = dataStructureSubstrate?.textNormalizationSubstrate || null;
  return [
    register(registry, {
      id: "data-structure-substrate.provider",
      platform: "data-structure-substrate",
      label: "Data structure substrate provider",
      kind: "substrate-provider",
      ownerFeatureId: "data-structure-substrate-core",
      value: dataStructureSubstrate,
      metadata: {
        protocolVersion: dataStructureSubstrate?.protocolVersion || "",
        provider: dataStructureSubstrate?.provider || "",
        providerProtocolVersion: dataStructureSubstrate?.providerProtocolVersion || "",
        capabilityIds: dataStructureSubstrate?.listCapabilities
          ? dataStructureSubstrate.listCapabilities().capabilities.map((capability?: any) : any => capability.id)
          : []
      }
    }),
    register(registry, {
      id: "checkpoint-tree.projection",
      platform: "data-structure-substrate",
      label: "Checkpoint tree projection",
      kind: "checkpoint-tree-projection",
      ownerFeatureId: "data-structure-substrate-core",
      value: checkpointTreeProjection,
      metadata: {
        protocolVersion: dataStructureSubstrate?.protocolVersion || "",
        provider: dataStructureSubstrate?.provider || "",
        providerProtocolVersion: dataStructureSubstrate?.providerCapabilities?.checkpointTreeProjection ||
          dataStructureSubstrate?.providerProtocolVersion ||
          ""
      }
    }),
    register(registry, {
      id: "merkle-state.substrate",
      platform: "data-structure-substrate",
      label: "Merkle state substrate",
      kind: "algorithm-substrate",
      ownerFeatureId: "data-structure-substrate-core",
      value: merkleStateSubstrate,
      metadata: {
        protocolVersion: merkleStateSubstrate?.protocolVersion || dataStructureSubstrate?.protocolVersion || "",
        provider: dataStructureSubstrate?.provider || "",
        providerProtocolVersion: dataStructureSubstrate?.providerCapabilities?.merkleStateSubstrate ||
          dataStructureSubstrate?.providerProtocolVersion ||
          ""
      }
    }),
    register(registry, {
      id: "text-normalization.substrate",
      platform: "data-structure-substrate",
      label: "Text normalization substrate",
      kind: "pure-algorithm-substrate",
      ownerFeatureId: "data-structure-substrate-core",
      value: textNormalizationSubstrate,
      metadata: {
        protocolVersion: dataStructureSubstrate?.protocolVersion || "",
        provider: dataStructureSubstrate?.provider || "",
        providerProtocolVersion: dataStructureSubstrate?.providerProtocolVersion || ""
      }
    })
  ];
}
