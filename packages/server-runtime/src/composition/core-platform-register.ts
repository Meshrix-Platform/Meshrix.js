import { registerPlatformService } from "./platform-registry.ts";
import { createCorePlatformProvider } from "./core-platform-provider.ts";

export function registerCorePlatformServices(registry?: any, {
  protocolEventBus = null,
  runtimeLogger = null,
  featureRuntime = null,
  operationLockManager = null,
  operationConcurrencyScope = "",
  operationProofSubstrate = null,
  sandboxExecution = null,
  opaqueArtifactCustody = null,
  coreProvider = null,
}: Record<string, any> = {}) : any {
  const effectiveCoreProvider: any = coreProvider || createCorePlatformProvider({
    protocolEventBus,
    runtimeLogger,
    featureRuntime,
    operationLockManager,
    operationConcurrencyScope,
    operationProofSubstrate,
  });
  return [
    registerPlatformService(registry, {
      id: "core.provider",
      platform: "core",
      label: "Core platform provider",
      kind: "provider",
      ownerFeatureId: "core-platform",
      value: effectiveCoreProvider,
      metadata: {
        protocolVersion: effectiveCoreProvider?.protocolVersion || "",
        operationProofSubstrateProvider: effectiveCoreProvider?.getOperationProofSubstrate?.()?.provider || "",
        capabilityIds: effectiveCoreProvider?.listCapabilities
          ? effectiveCoreProvider.listCapabilities().capabilities.map((capability?: any) : any => capability.id)
          : [],
      },
    }),
    registerPlatformService(registry, {
      id: "core.events.protocol",
      platform: "core",
      label: "Protocol event bus",
      kind: "events",
      ownerFeatureId: "core-platform",
      value: protocolEventBus,
    }),
    registerPlatformService(registry, {
      id: "core.logging.runtime",
      platform: "core",
      label: "Runtime logger",
      kind: "logging",
      ownerFeatureId: "core-platform",
      value: runtimeLogger,
    }),
    registerPlatformService(registry, {
      id: "core.features.runtime",
      platform: "core",
      label: "Feature runtime",
      kind: "features",
      ownerFeatureId: "core-platform",
      value: featureRuntime,
    }),
    registerPlatformService(registry, {
      id: "core.operations.lockManager",
      platform: "core",
      label: "Operation lock manager",
      kind: "dispatcher",
      ownerFeatureId: "core-platform",
      value: operationLockManager,
      metadata: {
        backend: operationLockManager?.config?.backend || ""
      },
    }),
    registerPlatformService(registry, {
      id: "core.execution.sandbox",
      platform: "core",
      label: "Controlled execution sandbox",
      kind: "execution-boundary",
      ownerFeatureId: "core-platform",
      value: sandboxExecution,
      metadata: {
        configurationState: sandboxExecution?.configurationState || "unconfigured",
        ...(sandboxExecution?.publicAvailability?.() || { sandboxAvailable: false })
      }
    }),
    registerPlatformService(registry, {
      id: "core.execution.opaque-custody",
      platform: "core",
      label: "Opaque no-run artifact custody",
      kind: "storage-boundary",
      ownerFeatureId: "core-platform",
      value: opaqueArtifactCustody,
      metadata: {
        plaintextPersistence: false,
        automaticPromotion: false
      }
    }),
    registerPlatformService(registry, {
      id: "core.operations.registry",
      platform: "core",
      label: "Operation registry governance",
      kind: "registry",
      ownerFeatureId: "core-platform",
      value: (input: Record<string, any> = {}) : any => effectiveCoreProvider.describeOperationRegistry(input),
      metadata: {
        protocolVersion: effectiveCoreProvider?.protocolVersion || "",
      },
    }),
  ];
}

export const registerPlatformCore: any = registerCorePlatformServices;
