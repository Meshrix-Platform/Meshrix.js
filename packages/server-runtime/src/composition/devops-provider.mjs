import {
  acknowledgeMonitorAlert,
  getMonitorAlertState,
  runMonitorAlertCycle,
  saveMonitorAlertConfig,
  transitionMonitorAlertLifecycle,
} from "./devops/monitor-alerts.mjs";
import {
  getBackgroundProcessStatus,
  setBackgroundProcessDeps,
} from "../../../foundation/src/observability/background-process-status.mjs";
import { recoverBackgroundSupervisor } from "./devops/supervisor-recovery.mjs";
import {
  composeUnifiedSystemStatus,
  normalizeUnifiedRegistration,
} from "../../../foundation/src/unified-registration-core/unified-registration.mjs";
import {
  atomicWriteJson,
  queueStateMutation,
  stateFileKey,
} from "../state/state-coordinator.mjs";
import { loadSettings } from "./settings.mjs";

export const DEVOPS_PROTOCOL_VERSION = "v0.0.1:platform:devops-1";

function wireBackgroundProcessDeps() {
  setBackgroundProcessDeps({
    atomicWriteJson,
    queueStateMutation,
    stateFileKey,
    loadSettings,
  });
}

export function createDevopsProvider({ userDataPath = "" } = {}) {
  wireBackgroundProcessDeps();
  return Object.freeze({
    protocolVersion: DEVOPS_PROTOCOL_VERSION,
    getBackgroundProcessStatus(input = {}) {
      return getBackgroundProcessStatus(input.userDataPath || userDataPath);
    },
    getMonitorAlertState(input = {}) {
      return getMonitorAlertState(input.userDataPath || userDataPath, input);
    },
    saveMonitorAlertConfig(input = {}) {
      return saveMonitorAlertConfig(input.userDataPath || userDataPath, input.config || input);
    },
    runMonitorAlertCycle(input = {}) {
      return runMonitorAlertCycle(input.userDataPath || userDataPath, input);
    },
    acknowledgeMonitorAlert(input = {}) {
      return acknowledgeMonitorAlert(
        input.userDataPath || userDataPath,
        input.alertId || input["alert-id"] || input.id || "",
        input,
      );
    },
    transitionMonitorAlertLifecycle(input = {}) {
      return transitionMonitorAlertLifecycle(
        input.userDataPath || userDataPath,
        input.alertId || input["alert-id"] || input.id || "",
        input.event || "",
        input
      );
    },
    async recoverBackgroundSupervisor(input = {}) {
      const effectiveUserDataPath = input.userDataPath || userDataPath;
      const backgroundStatus =
        input.backgroundStatus ||
        (await getBackgroundProcessStatus(effectiveUserDataPath));
      return recoverBackgroundSupervisor({
        ...input,
        userDataPath: effectiveUserDataPath,
        backgroundStatus,
      });
    },
    createMonitorAlertApi({ workQueueObservation = null } = {}) {
      return Object.freeze({
        getState: () => getMonitorAlertState(userDataPath, { workQueueObservation }),
        saveConfig: (input = {}) => saveMonitorAlertConfig(userDataPath, input),
        acknowledge: (alertId = "") => acknowledgeMonitorAlert(userDataPath, alertId, { workQueueObservation }),
        transition: (alertId = "", event = "", input = {}) =>
          transitionMonitorAlertLifecycle(userDataPath, alertId, event, input),
      });
    },
    normalizeUnifiedRegistration,
    composeUnifiedSystemStatus,
    listCapabilities() {
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
