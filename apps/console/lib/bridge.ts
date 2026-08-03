import type { Bridge } from "./bridge-types";
import { downloadFile } from "@meshrix/ui-console/bridge-http";
import {
  getAuthOidc,
  getAuthSession,
  listAuthAudit,
  listAuthSessions,
  listAuthUsers,
  loginAuth,
  logoutAuth,
  revokeAuthSession,
  saveAuthOidc,
  updateAuthUser,
} from "./auth-client";
import {
  getSettings,
  probeModel,
  saveSettings,
} from "./agent-settings-client";
import { listAgents } from "./agent-registry-client";
import {
  getAgentSyncConfig,
  publishAgentSync,
  saveAgentSyncConfig,
  subscribeAgentSync,
} from "./agent-sync-client";
import { getServerConsoleState } from "./console-state-client";
import {
  getDiscoveryClients,
  getDiscoveryConfig,
  saveDiscoveryConfig,
} from "./discovery-client";
import {
  approveMaintenanceAgentRun,
  cancelMaintenanceAgentRun,
  chatMaintenanceAgent,
  getMaintenanceAgentConfig,
  getMaintenanceAgentRun,
  listMaintenanceAgentRuns,
  saveMaintenanceAgentConfig,
  startMaintenanceAgentRun,
} from "./maintenance-agent-client";
import {
  reloadRuntimeMounts,
  saveRuntimeMounts,
} from "./runtime-mounts-client";
import {
  browseServerPath,
  getRuntimeInfo,
} from "./runtime-info-client";
import { subscribeEvents } from "./server-events-client";
import {
  createUploadSession,
  getUploadSession,
  uploadSessionChunk,
} from "./upload-session-client";
import {
  createJob,
  deleteJob,
  getJob,
  getJobResult,
  listJobs,
  reparseJob,
} from "./jobs-client";
import {
  getProductionHealth,
  getReadinessBaselineStatus,
} from "./production-health-client";
import {
  acknowledgeMonitorAlert,
  getBackgroundProcesses,
  getMonitorAlerts,
  recoverBackgroundSupervisor,
  saveMonitorAlertConfig,
} from "./ops-monitor-client";
import {
  getContextProfiles,
  listContextBuildRecords,
  previewContextPack,
  runContextEvaluation,
} from "./context-compiler-client";
import {
  getAuthorizationGovernance,
  revokeAuthorizationApproval,
  upsertAuthorizationGovernance,
} from "./authorization-governance-client";
import {
  createToolGrant,
  deleteToolGrant,
  getOperationPermissionAudit,
  getOperationPermissionCatalog,
  getOperationPermissionGrants,
  getOperationPermissionMetrics,
  listPendingOperations,
  previewToolPolicy,
  resolvePendingOperation,
  rotateToolGrantToken,
  updateToolGrant,
} from "./operation-permission-client";
import {
  callAgentGateway,
} from "./agent-gateway-client";

export type { BridgeDownloadOptions, BridgeDownloadResult } from "@meshrix/ui-console/bridge-http";
const browserBridge: Bridge = {
  getAuthSession,
  loginAuth,
  logoutAuth,
  downloadFile,
  listAuthUsers,
  updateAuthUser,
  getAuthOidc,
  saveAuthOidc,
  listAuthAudit,
  listAuthSessions,
  revokeAuthSession,
  getAuthorizationGovernance,
  upsertAuthorizationGovernance,
  revokeAuthorizationApproval,
  getSettings,
  saveSettings,
  probeModel,
  callAgentGateway,
  listAgents,
  getAgentSyncConfig,
  saveAgentSyncConfig,
  publishAgentSync,
  subscribeAgentSync,
  getRuntimeInfo,
  browseServerPath,
  saveRuntimeMounts,
  reloadRuntimeMounts,
  getServerConsoleState,
  getMaintenanceAgentConfig,
  saveMaintenanceAgentConfig,
  chatMaintenanceAgent,
  startMaintenanceAgentRun,
  listMaintenanceAgentRuns,
  getMaintenanceAgentRun,
  approveMaintenanceAgentRun,
  cancelMaintenanceAgentRun,
  getBackgroundProcesses,
  recoverBackgroundSupervisor,
  getMonitorAlerts,
  getProductionHealth,
  getReadinessBaselineStatus,
  saveMonitorAlertConfig,
  acknowledgeMonitorAlert,
  subscribeEvents,
  getOperationPermissionCatalog,
  getOperationPermissionAudit,
  getOperationPermissionMetrics,
  previewToolPolicy,
  getOperationPermissionGrants,
  listPendingOperations,
  resolvePendingOperation,
  createToolGrant,
  updateToolGrant,
  deleteToolGrant,
  rotateToolGrantToken,
  getDiscoveryConfig,
  saveDiscoveryConfig,
  pickFiles: async () : Promise<any> => [],
  pickFolders: async () : Promise<any> => [],
  createJob,
  reparseJob,
  listJobs,
  deleteJob,
  getJob,
  getJobResult,
  getDiscoveryClients,
  getContextProfiles,
  previewContextPack,
  listContextBuildRecords,
  runContextEvaluation,
  createUploadSession,
  uploadSessionChunk,
  getUploadSession,
};

export const bridge: any = browserBridge;
