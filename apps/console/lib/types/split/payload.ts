import type { AgentSettings } from "../agent";

export type SplitCheckpointPayload = {
  checkpointId?: string;
  mode?: string;
};

export type SplitPayload = {
  checkpoint?: SplitCheckpointPayload;
  forceNewVersion?: boolean;
  inputText?: string;
  parentJobId?: string;
  settings?: AgentSettings;
  uploadSessionId?: string;
  versionGroupId?: string;
  workspaceId?: string;
};
