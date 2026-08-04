import { computed } from "vue";
import type { SystemLogRow } from "../types/app";
import {
  buildBaseServerLogRows,
  type ConsoleBaseServerLogRowOptions,
} from "./console-system-log-base-row-controller";
import {
  buildSystemStatusLogRows,
  type ConsoleSystemStatusLogRowOptions,
} from "./console-system-log-status-row-controller";
import {
  compactLogDetail,
  genericStatusTone,
  stateProgressPercent,
} from "./console-system-log-row-utils";
import { parseTime } from "@meshrix/ui-console/console-format-utils";

type ConsoleSystemLogRowControllerOptions = ConsoleBaseServerLogRowOptions &
  ConsoleSystemStatusLogRowOptions;

function dedupeLogRows(rows: SystemLogRow[]) : any {
  const seen: any = new Set<string>();
  return rows.filter((row?: any) : any => {
    if (seen.has(row.logId)) {
      return false;
    }
    seen.add(row.logId);
    return true;
  });
}

export function createConsoleSystemLogRowController(
  options: ConsoleSystemLogRowControllerOptions,
) : any {
  const baseServerLogRows: any = computed<SystemLogRow[]>(() : any => buildBaseServerLogRows(options));

  function collectSystemStatusLogRows() : any {
    return buildSystemStatusLogRows(options);
  }

  const serverLogRows: any = computed<SystemLogRow[]>(() : any =>
    dedupeLogRows([...collectSystemStatusLogRows(), ...baseServerLogRows.value]).sort(
      (left?: any, right?: any) : any => parseTime(right.occurredAt) - parseTime(left.occurredAt),
    ),
  );

  return {
    baseServerLogRows,
    collectSystemStatusLogRows,
    compactLogDetail,
    genericStatusTone,
    serverLogRows,
    stateProgressPercent,
  };
}
