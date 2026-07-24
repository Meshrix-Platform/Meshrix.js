import type { Ref } from "vue";
import type { ServerPathBrowseResponse } from "../lib/types";

export type AppView = "dashboard" | "approval" | "workspaces" | "admin" | string;
export type AdminView = string;
export type CloudProvider =
  | "openai"
  | "deepseek"
  | "openrouter"
  | "copilot"
  | "local-model"
  | string;

export type OptionBarValue = string | number | boolean;
export type OptionBarModelValue = OptionBarValue | OptionBarValue[];
export type OptionBarIcon = "moon" | "sun";

export type OptionBarOption = {
  value: OptionBarValue;
  label: string;
  description?: string;
  disabled?: boolean;
  swatches?: string[];
  icon?: OptionBarIcon;
};

export type RefreshStateOptions = {
  silent?: boolean;
  forceSettings?: boolean;
  forceDrafts?: boolean;
};

export type PathPickerMode = "file" | "directory";

export type PathPickerState = {
  open: boolean;
  title: string;
  mode: PathPickerMode;
  value: string;
  extensions: string[];
  includeHidden: boolean;
  loading: boolean;
  error: string;
  response: ServerPathBrowseResponse | null;
  closeOnSelect: boolean;
  applyPath: (nextPath: string) => void;
};

export type HistorySessionPanelItem = {
  id: string;
  title?: string;
  meta?: string;
  preview?: string;
  active?: boolean;
  disabled?: boolean;
  deleteLabel?: string;
  deleteText?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  actionDisabled?: boolean;
};

export type AgentConfigurationAlert = {
  alertId: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  tone: "danger" | "warning" | "success";
  view?: AppView;
  adminView?: AdminView;
  targetId?: string;
  value?: string;
  options?: Array<Record<string, unknown>>;
  actionLabel?: string;
  source?: string;
};

export type DashboardAlert = {
  alertId: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  tone: "danger" | "warning" | "success";
  actionLabel: string;
  actionKind?: "open" | "recover-supervisor" | string;
  source: "monitor" | "configuration" | string;
  live?: boolean;
  firstSeenAt?: string;
  lastSeenAt?: string;
  resolvedAt?: string;
  monitorAlert?: {
    ackRequired?: boolean;
    active?: boolean;
    status?: string;
    [key: string]: unknown;
  };
  configAlert?: AgentConfigurationAlert;
};

export type SystemLogRow = {
  logId: string;
  kindLabel: string;
  displayId: string;
  target: string;
  status: string;
  statusLabel: string;
  tone: "danger" | "warning" | "success" | "info" | "muted" | "neutral" | string;
  stage: string;
  occurredAt: string;
  createdAt: string;
  progressPercent: number;
  detail: string;
  error: string;
};

export type WorkQueueRow = {
  rowId: string;
  queueId: string;
  kind: string;
  label: string;
  ownerId: string;
  source: string;
  sourceLabel: string;
  lifecycleStatus: string;
  status: string;
  phase: string;
  tone: SystemLogRow["tone"];
  startedAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  checkpointTreeId: string;
  detail: string;
  registration?: {
    registrationId?: string;
    label?: string;
    source?: string;
    status?: string;
    tone?: SystemLogRow["tone"];
    registeredAt?: string;
    attributes?: Record<string, unknown>;
    relations?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type ModelEntryBinding = {
  bindingId: string;
  category: string;
  label: string;
  detail: string;
  source: "draft" | "runtime" | "settings" | string;
};

export type RefLike<T> = Ref<T> | { readonly value: T };
