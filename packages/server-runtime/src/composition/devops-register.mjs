import { registerPlatformService } from "./platform-registry.mjs";
import { createDevopsProvider } from "./devops-provider.mjs";
import {
  composeUnifiedSystemStatus,
  normalizeUnifiedRegistration,
} from "../../../foundation/src/unified-registration-core/unified-registration.mjs";

export function registerDevopsPlatformServices(registry, {
  userDataPath = "",
  devopsProvider = null,
} = {}) {
  const effectiveDevopsProvider = devopsProvider || createDevopsProvider({ userDataPath });
  return [
    registerPlatformService(registry, {
      id: "devops.provider",
      platform: "devops",
      label: "DevOps provider",
      kind: "provider",
      ownerFeatureId: "devops-core",
      value: effectiveDevopsProvider,
      metadata: {
        protocolVersion: effectiveDevopsProvider?.protocolVersion || "",
        capabilityIds: effectiveDevopsProvider?.listCapabilities
          ? effectiveDevopsProvider.listCapabilities().capabilities.map((capability) => capability.id)
          : [],
      },
    }),
    registerPlatformService(registry, {
      id: "devops.processStatus.get",
      platform: "devops",
      label: "Background process status",
      kind: "process-status",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.getBackgroundProcessStatus(input),
    }),
    registerPlatformService(registry, {
      id: "devops.monitorAlerts.state",
      platform: "devops",
      label: "Monitor alert state",
      kind: "alerts",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.getMonitorAlertState(input),
    }),
    registerPlatformService(registry, {
      id: "devops.monitorAlerts.saveConfig",
      platform: "devops",
      label: "Monitor alert config",
      kind: "alerts",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.saveMonitorAlertConfig(input),
    }),
    registerPlatformService(registry, {
      id: "devops.monitorAlerts.runCycle",
      platform: "devops",
      label: "Monitor alert cycle",
      kind: "alerts",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.runMonitorAlertCycle(input),
    }),
    registerPlatformService(registry, {
      id: "devops.monitorAlerts.acknowledge",
      platform: "devops",
      label: "Monitor alert acknowledge",
      kind: "alerts",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.acknowledgeMonitorAlert(input),
    }),
    registerPlatformService(registry, {
      id: "devops.backgroundSupervisor.recover",
      platform: "devops",
      label: "Recover background supervisor",
      kind: "process-control",
      ownerFeatureId: "monitor-alert-core",
      value: (input = {}) => effectiveDevopsProvider.recoverBackgroundSupervisor(input),
    }),
    registerPlatformService(registry, {
      id: "devops.unifiedRegistration.normalize",
      platform: "devops",
      label: "Unified registration normalize",
      kind: "registration",
      ownerFeatureId: "unified-registration-core",
      value: normalizeUnifiedRegistration,
    }),
    registerPlatformService(registry, {
      id: "devops.unifiedRegistration.composeStatus",
      platform: "devops",
      label: "Unified system status compose",
      kind: "registration",
      ownerFeatureId: "unified-registration-core",
      value: composeUnifiedSystemStatus,
    }),
  ];
}

export const registerDevops = registerDevopsPlatformServices;
