export type {
  ConsoleAuditItem,
  ConsoleAuthSession,
  ConsoleAuthSummary,
  ConsoleOidcConfig,
  ConsoleRole,
  ConsoleUser,
} from "./auth-types";

export type * from "./types/agent";
export type * from "./types/runtime";
export type * from "./types/split";
export type * from "./types/operation-permission";
export type * from "./types/ops";
export type * from "./types/production-health";
export type * from "./types/console-state";

export type UploadSessionResponse = {
  ok?: boolean;
  sessionId?: string;
  status?: string;
  files?: Array<Record<string, unknown>>;
  error?: string;
  [key: string]: unknown;
};
