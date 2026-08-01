import { CONSOLE_ADMINISTRATION_PLATFORM_WORKFLOWS } from "./console-administration-platform-workflows.ts";

const platformById: any = new Map<any, any>(
  CONSOLE_ADMINISTRATION_PLATFORM_WORKFLOWS.map((workflow?: any) : any => [workflow.id, workflow])
);

export const CONSOLE_ADMINISTRATION_WORKFLOWS: readonly any[] = Object.freeze([
  platformById.get("gateway"),
  platformById.get("operation-permission-mcp"),
  platformById.get("storage-jobs"),
  platformById.get("release-readiness")
]);

export const PLUGIN_CONSOLE_AUTHORITIES: readonly any[] = Object.freeze([]);
