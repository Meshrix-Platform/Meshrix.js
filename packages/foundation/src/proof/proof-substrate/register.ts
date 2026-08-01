// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerOperationProofSubstratePlatformServices(registry?: any, {
  operationProofSubstrate = null,
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
  const capabilities: any = operationProofSubstrate?.listCapabilities
    ? operationProofSubstrate.listCapabilities().capabilities
    : [];
  return [
    register(registry, {
      id: "operation-proof-substrate.provider",
      platform: "operation-proof-substrate",
      label: "Operation Proof Substrate provider",
      kind: "provider",
      ownerFeatureId: "operation-proof-substrate",
      value: operationProofSubstrate,
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || "",
        mode: operationProofSubstrate?.mode || "",
        productionVerifiable: operationProofSubstrate?.productionVerifiable === true,
        capabilityIds: capabilities.map((capability?: any) : any => capability.id)
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.lifecycle",
      platform: "operation-proof-substrate",
      label: "Operation proof lifecycle",
      kind: "proof-lifecycle",
      ownerFeatureId: "operation-proof-substrate",
      value: {
        beginLifecycle: (input: Record<string, any> = {}) : any => operationProofSubstrate?.beginLifecycle(input),
        finishLifecycle: (input: Record<string, any> = {}) : any => operationProofSubstrate?.finishLifecycle(input),
        denyLifecycle: (input: Record<string, any> = {}) : any => operationProofSubstrate?.denyLifecycle(input),
        recordReceipt: (input: Record<string, any> = {}) : any => operationProofSubstrate?.recordReceipt(input)
      },
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        mode: operationProofSubstrate?.mode || ""
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.verify",
      platform: "operation-proof-substrate",
      label: "Operation proof verification",
      kind: "proof-verifier",
      ownerFeatureId: "operation-proof-substrate",
      value: {
        verifyReceipt: (input: Record<string, any> = {}) : any => operationProofSubstrate?.verifyReceipt(input),
        verifyEnvelope: (envelope?: any, options: Record<string, any> = {}) : any => operationProofSubstrate?.verifyEnvelope(envelope, options),
        verifyBundle: (bundle?: any, options: Record<string, any> = {}) : any => operationProofSubstrate?.verifyBundle(bundle, options)
      },
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || ""
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.export",
      platform: "operation-proof-substrate",
      label: "Proof Bundle Export",
      kind: "proof-export",
      ownerFeatureId: "operation-proof-substrate",
      value: (input: Record<string, any> = {}) : any => operationProofSubstrate?.exportProofBundle(input),
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || ""
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.recover",
      platform: "operation-proof-substrate",
      label: "Operation proof recovery",
      kind: "proof-recovery",
      ownerFeatureId: "operation-proof-substrate",
      value: (input: Record<string, any> = {}) : any => operationProofSubstrate?.planRecovery(input),
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || ""
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.project",
      platform: "operation-proof-substrate",
      label: "Workspace proof projection",
      kind: "proof-projection",
      ownerFeatureId: "operation-proof-substrate",
      value: {
        getWorkspaceProjection: (workspaceId: any = "default") : any => operationProofSubstrate?.getWorkspaceProjection(workspaceId),
        proveWorkspaceMembership: (input: Record<string, any> = {}) : any => operationProofSubstrate?.proveWorkspaceMembership(input)
      },
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || ""
      }
    }),
    register(registry, {
      id: "operation-proof-substrate.acceptance-evidence",
      platform: "operation-proof-substrate",
      label: "Acceptance evidence ledger anchoring",
      kind: "proof-acceptance-evidence",
      ownerFeatureId: "operation-proof-substrate",
      value: {
        recordAcceptanceEvidence: (input: Record<string, any> = {}) : any => operationProofSubstrate?.recordAcceptanceEvidence(input)
      },
      metadata: {
        protocolVersion: operationProofSubstrate?.protocolVersion || "",
        provider: operationProofSubstrate?.provider || "",
        digestOnly: true
      }
    })
  ];
}
