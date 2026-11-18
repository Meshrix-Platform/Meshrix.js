import type { SystemLogRow } from "../types/app";

export type ConsoleBaseServerLogRowOptions = {
  agentSelectionReferenceLogs?: {
    readonly value: SystemLogRow[];
  };
};

export function buildBaseServerLogRows(options: ConsoleBaseServerLogRowOptions): SystemLogRow[] {
  return [...(options.agentSelectionReferenceLogs?.value || [])];
}
