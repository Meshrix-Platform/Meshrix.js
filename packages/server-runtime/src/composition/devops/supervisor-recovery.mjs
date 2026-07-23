import {
  launchAgentTargets,
  recoverLaunchAgentService,
} from "../../../../foundation/src/environment-compatibility/host-services.mjs";

const DEFAULT_SUPERVISOR_SERVICE_LABEL = "dev.lico.background-supervisor";
const DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL = "dev.lico.system-inspection";
const SUPERVISOR_RECOVERY_PROTOCOL_VERSION = "v0.0.1:platform:supervisor-recovery-1";

function recoveryEnvelope(result = {}, { serviceLabel = "", alreadyRunning = false } = {}) {
  const targets = result.serviceTarget
    ? {
        serviceLabel: result.serviceLabel || serviceLabel,
        uid: result.uid,
        launchTarget: result.launchTarget,
        serviceTarget: result.serviceTarget,
        plistPath: result.plistPath || "",
      }
    : null;
  return {
    protocolVersion: SUPERVISOR_RECOVERY_PROTOCOL_VERSION,
    ...result,
    serviceLabel: result.serviceLabel || serviceLabel,
    alreadyRunning,
    recovered: result.ok === true && result.attempted === true,
    action: result.action || (alreadyRunning ? "already_running" : "manual_recovery_required"),
    reason: result.reason || (alreadyRunning ? "already_running" : ""),
    targets,
    at: result.checkedAt || new Date().toISOString(),
  };
}

export function supervisorLaunchAgentTargets(options = {}) {
  return launchAgentTargets({
    defaultServiceLabel: DEFAULT_SUPERVISOR_SERVICE_LABEL,
    ...options,
  });
}

export function systemInspectionLaunchAgentTargets(options = {}) {
  return launchAgentTargets({
    defaultServiceLabel: DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL,
    ...options,
  });
}

export async function recoverBackgroundSupervisor(options = {}) {
  const backgroundStatus = options.backgroundStatus || {};
  const serviceLabel = String(options.serviceLabel || DEFAULT_SUPERVISOR_SERVICE_LABEL).trim() ||
    DEFAULT_SUPERVISOR_SERVICE_LABEL;
  const alreadyRunning = Boolean(backgroundStatus.supervisor?.alive);
  const result = await recoverLaunchAgentService({
    ...options,
    serviceLabel,
    alreadyRunning,
    targetsFactory: supervisorLaunchAgentTargets,
  });
  return recoveryEnvelope(result, { serviceLabel, alreadyRunning });
}

export async function recoverSystemInspection(options = {}) {
  const backgroundStatus = options.backgroundStatus || {};
  const processItem =
    options.processItem ||
    (Array.isArray(backgroundStatus.processes)
      ? backgroundStatus.processes.find((item) => item?.role === "system-inspection")
      : null);
  const serviceLabel = String(options.serviceLabel || DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL).trim() ||
    DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL;
  const alreadyRunning = Boolean(processItem?.alive && processItem?.status !== "stopped");
  const result = await recoverLaunchAgentService({
    ...options,
    serviceLabel,
    alreadyRunning,
    targetsFactory: systemInspectionLaunchAgentTargets,
  });
  return recoveryEnvelope(result, { serviceLabel, alreadyRunning });
}
