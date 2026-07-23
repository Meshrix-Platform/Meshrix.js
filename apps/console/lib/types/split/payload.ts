import type { AgentSettings } from "../agent";

export type SplitPayload = {
  inputText: string;
  filePaths: string[];
  uploadedFiles: UploadedFilePayload[];
  uploadSessionId?: string;
  forceNewVersion?: boolean;
  reparseFromJobId?: string;
  parentJobId?: string;
  versionGroupId?: string;
  archiveBatchId?: string;
  settings: AgentSettings;
};

export type UploadedFilePayload = {
  name: string;
  mediaType: string;
  dataBase64: string;
  relativePath?: string;
  originalFileName?: string;
  stagedPath?: string;
  sha256?: string;
  byteSize?: number;
};
