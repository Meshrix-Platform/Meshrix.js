import {
  launchAgentTargets,
  recoverLaunchAgentService,
} from "#meshrix/foundation/environment-compatibility/host-services";

const DEFAULT_SUPERVISOR_SERVICE_LABEL: any = "dev.meshrix.background-supervisor";
const DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL: any = "dev.meshrix.system-inspection";
const SUPERVISOR_RECOVERY_PROTOCOL_VERSION: any = "v0.0.1:platform:supervisor-recovery-1";

function recoveryEnvelope(result: Record<string, any> = {}, { serviceLabel = "", alreadyRunning = false }: Record<string, any> = {}) : any {
  const targets: any = result.serviceTarget
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

export function supervisorLaunchAgentTargets(options: Record<string, any> = {}) : any {
  return launchAgentTargets({
    defaultServiceLabel: DEFAULT_SUPERVISOR_SERVICE_LABEL,
    ...options,
  });
}

export function systemInspectionLaunchAgentTargets(options: Record<string, any> = {}) : any {
  return launchAgentTargets({
    defaultServiceLabel: DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL,
    ...options,
  });
}

export async function recoverBackgroundSupervisor(options: Record<string, any> = {}) : Promise<any> {
  const backgroundStatus: any = options.backgroundStatus || {};
  const serviceLabel: any = String(options.serviceLabel || DEFAULT_SUPERVISOR_SERVICE_LABEL).trim() ||
    DEFAULT_SUPERVISOR_SERVICE_LABEL;
  const alreadyRunning: any = Boolean(backgroundStatus.supervisor?.alive);
  const result: any = await recoverLaunchAgentService({
    ...options,
    serviceLabel,
    alreadyRunning,
    targetsFactory: supervisorLaunchAgentTargets,
  });
  return recoveryEnvelope(result, { serviceLabel, alreadyRunning });
}

export async function recoverSystemInspection(options: Record<string, any> = {}) : Promise<any> {
  const backgroundStatus: any = options.backgroundStatus || {};
  const processItem: any =
    options.processItem ||
    (Array.isArray(backgroundStatus.processes)
      ? backgroundStatus.processes.find((item?: any) : any => item?.role === "system-inspection")
      : null);
  const serviceLabel: any = String(options.serviceLabel || DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL).trim() ||
    DEFAULT_SYSTEM_INSPECTION_SERVICE_LABEL;
  const alreadyRunning: any = Boolean(processItem?.alive && processItem?.status !== "stopped");
  const result: any = await recoverLaunchAgentService({
    ...options,
    serviceLabel,
    alreadyRunning,
    targetsFactory: systemInspectionLaunchAgentTargets,
  });
  return recoveryEnvelope(result, { serviceLabel, alreadyRunning });
}
