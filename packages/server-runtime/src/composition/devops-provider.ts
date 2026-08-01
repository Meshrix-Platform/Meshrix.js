import {
  acknowledgeMonitorAlert,
  getMonitorAlertState,
  runMonitorAlertCycle,
  saveMonitorAlertConfig,
  transitionMonitorAlertLifecycle,
} from "./devops/monitor-alerts.ts";
import {
  getBackgroundProcessStatus,
  setBackgroundProcessDeps,
} from "#meshrix/foundation/observability/background-process-status";
import { recoverBackgroundSupervisor } from "./devops/supervisor-recovery.ts";
import {
  composeUnifiedSystemStatus,
  normalizeUnifiedRegistration,
} from "#meshrix/foundation/unified-registration-core/unified-registration";
import {
  atomicWriteJson,
  queueStateMutation,
  stateFileKey,
} from "../state/state-coordinator.ts";
import { loadSettings } from "./settings.ts";

export const DEVOPS_PROTOCOL_VERSION: any = "v0.0.1:platform:devops-1";

function wireBackgroundProcessDeps() : any {
  setBackgroundProcessDeps({
    atomicWriteJson,
    queueStateMutation,
    stateFileKey,
    loadSettings,
  });
}

export function createDevopsProvider({ userDataPath = "" }: Record<string, any> = {}) : any {
  wireBackgroundProcessDeps();
  return Object.freeze({
    protocolVersion: DEVOPS_PROTOCOL_VERSION,
    getBackgroundProcessStatus(input: Record<string, any> = {}) : any {
      return getBackgroundProcessStatus(input.userDataPath || userDataPath);
    },
    getMonitorAlertState(input: Record<string, any> = {}) : any {
      return getMonitorAlertState(input.userDataPath || userDataPath, input);
    },
    saveMonitorAlertConfig(input: Record<string, any> = {}) : any {
      return saveMonitorAlertConfig(input.userDataPath || userDataPath, input.config || input);
    },
    runMonitorAlertCycle(input: Record<string, any> = {}) : any {
      return runMonitorAlertCycle(input.userDataPath || userDataPath, input);
    },
    acknowledgeMonitorAlert(input: Record<string, any> = {}) : any {
      return acknowledgeMonitorAlert(
        input.userDataPath || userDataPath,
        input.alertId || input["alert-id"] || input.id || "",
        input,
      );
    },
    transitionMonitorAlertLifecycle(input: Record<string, any> = {}) : any {
      return transitionMonitorAlertLifecycle(
        input.userDataPath || userDataPath,
        input.alertId || input["alert-id"] || input.id || "",
        input.event || "",
        input
      );
    },
    async recoverBackgroundSupervisor(input: Record<string, any> = {}) : Promise<any> {
      const effectiveUserDataPath: any = input.userDataPath || userDataPath;
      const backgroundStatus: any =
        input.backgroundStatus ||
        (await getBackgroundProcessStatus(effectiveUserDataPath));
      return recoverBackgroundSupervisor({
        ...input,
        userDataPath: effectiveUserDataPath,
        backgroundStatus,
      });
    },
    createMonitorAlertApi({ workQueueObservation = null }: Record<string, any> = {}) : any {
      return Object.freeze({
        getState: () : any => getMonitorAlertState(userDataPath, { workQueueObservation }),
        saveConfig: (input: Record<string, any> = {}) : any => saveMonitorAlertConfig(userDataPath, input),
        acknowledge: (alertId: any = "") : any => acknowledgeMonitorAlert(userDataPath, alertId, { workQueueObservation }),
        transition: (alertId: any = "", event: any = "", input: Record<string, any> = {}) : any =>
          transitionMonitorAlertLifecycle(userDataPath, alertId, event, input),
      });
    },
    normalizeUnifiedRegistration,
    composeUnifiedSystemStatus,
    listCapabilities() : any {
      return {
        protocolVersion: DEVOPS_PROTOCOL_VERSION,
        capabilities: [
          {
            id: "process-status",
            kind: "observation",
            operations: ["getBackgroundProcessStatus"],
          },
          {
            id: "monitor-alerts",
            kind: "observation-and-control",
            operations: [
              "getMonitorAlertState",
              "saveMonitorAlertConfig",
              "runMonitorAlertCycle",
              "acknowledgeMonitorAlert",
              "transitionMonitorAlertLifecycle",
              "recoverBackgroundSupervisor",
              "createMonitorAlertApi",
            ],
          },
          {
            id: "unified-registration",
            kind: "normalization",
            operations: ["normalizeUnifiedRegistration", "composeUnifiedSystemStatus"],
          },
        ],
      };
    },
  });
}
