import { computed, onMounted, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import type { OptionBarOption, SystemLogRow } from "../types/app";
import { downloadTextFile } from "./console-browser-effects";
import { systemLogPaginationConfig } from "./console-defaults";
import { formatMachineDate, parseTime } from "@meshrix/ui-console/console-format-utils";
import { useConsoleUrlState } from "./use-console-url-state";

type SystemLogFilters = {
  fuzzy: string;
  kind: string;
  status: string;
  from: string;
  to: string;
};

type SystemLogScrollPayload = Event | {
  scrollLeft?: number;
  scrollTop?: number;
};

type ConsoleSystemLogControllerOptions = {
  serverLogRows: ComputedRef<SystemLogRow[]>;
};

function csvCell(value: unknown) : any {
  const text: any = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function rowSearchText(row: SystemLogRow) : any {
  return [
    row.logId,
    row.kindLabel,
    row.displayId,
    row.target,
    row.status,
    row.statusLabel,
    row.stage,
    row.occurredAt,
    row.createdAt,
    row.detail,
    row.error,
  ].join("\n").toLocaleLowerCase();
}

function dateBoundary(value: string, endOfDay: any = false) : any {
  if (!value) {
    return endOfDay ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
}

export function createConsoleSystemLogController(
  options: ConsoleSystemLogControllerOptions,
) : any {
  // Each filter leaf is owned by the URL (log.* query keys); the reactive
  // wrapper keeps the existing `.value.<field>` read path and v-model writes.
  const systemLogFilters: any = ref<SystemLogFilters>(
    reactive({
      fuzzy: useConsoleUrlState("log.fuzzy", ""),
      kind: useConsoleUrlState("log.kind", "all"),
      status: useConsoleUrlState("log.status", "all"),
      from: useConsoleUrlState("log.from", ""),
      to: useConsoleUrlState("log.to", ""),
    }),
  );
  const systemLogColumnWidths: any = ref({
    kind: 88,
    target: 160,
    time: 150,
    status: 96,
    progress: 72,
    stage: 112,
    detail: 210,
    error: 146,
  });
  const systemLogPageParam: Ref<string> = useConsoleUrlState("log.page", "1");
  const systemLogCurrentPage: any = computed<number>({
    get: (): number => {
      const parsed: number = Number(systemLogPageParam.value);
      return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
    },
    set: (next: number): void => {
      systemLogPageParam.value = String(next);
    },
  });
  const systemLogPageSizeParam: Ref<string> = useConsoleUrlState(
    "log.pageSize",
    String(systemLogPaginationConfig.defaultPageSize),
  );
  const systemLogPageSize: any = computed<number>({
    get: (): number => {
      const parsed: number = Number(systemLogPageSizeParam.value);
      return Number.isSafeInteger(parsed) && parsed >= 1
        ? parsed
        : systemLogPaginationConfig.defaultPageSize;
    },
    set: (next: number): void => {
      systemLogPageSizeParam.value = String(next);
    },
  });
  const systemLogTableShellRef: any = ref<HTMLElement | null>(null);
  const systemLogScrollTop: any = ref(0);

  const filteredSystemLogRows: any = computed(() : any => {
    const fuzzy: any = systemLogFilters.value.fuzzy.trim().toLocaleLowerCase();
    const from: any = dateBoundary(systemLogFilters.value.from);
    const to: any = dateBoundary(systemLogFilters.value.to, true);
    return options.serverLogRows.value.filter((row?: any) : any => {
      if (systemLogFilters.value.kind !== "all" && row.kindLabel !== systemLogFilters.value.kind) {
        return false;
      }
      if (systemLogFilters.value.status !== "all" && row.status !== systemLogFilters.value.status) {
        return false;
      }
      const occurredAt: any = parseTime(row.occurredAt || row.createdAt);
      if (Number.isFinite(from) && occurredAt < from) {
        return false;
      }
      if (Number.isFinite(to) && occurredAt > to) {
        return false;
      }
      return !fuzzy || rowSearchText(row).includes(fuzzy);
    });
  });

  const systemLogPageTotal: any = computed(() : any => filteredSystemLogRows.value.length);
  const normalizedPageSize: any = computed(() : any => Math.max(
    1,
    Math.min(systemLogPaginationConfig.maxPageSize, Number(systemLogPageSize.value) || systemLogPaginationConfig.defaultPageSize),
  ));
  const systemLogPageCount: any = computed(() : any =>
    Math.max(1, Math.ceil(systemLogPageTotal.value / normalizedPageSize.value)),
  );
  const systemLogPageRange: any = computed(() : any => ({
    start: systemLogPageTotal.value === 0
      ? 0
      : (systemLogCurrentPage.value - 1) * normalizedPageSize.value + 1,
    end: Math.min(
      systemLogPageTotal.value,
      systemLogCurrentPage.value * normalizedPageSize.value,
    ),
  }));
  const paginatedSystemLogRows: any = computed(() : any => {
    const start: any = (systemLogCurrentPage.value - 1) * normalizedPageSize.value;
    return filteredSystemLogRows.value.slice(start, start + normalizedPageSize.value);
  });

  const systemLogKindOptionBarOptions: any = computed<OptionBarOption[]>(() : any => [
    { value: "all", label: "全部类型" },
    ...[...new Set<any>(options.serverLogRows.value.map((row?: any) : any => row.kindLabel).filter(Boolean))]
      .sort((left?: any, right?: any) : any => left.localeCompare(right))
      .map((value?: any) : any => ({ value, label: value })),
  ]);
  const systemLogStatusOptionBarOptions: any = computed<OptionBarOption[]>(() : any => {
    const labels: any = new Map<string, string>();
    for (const row of options.serverLogRows.value) {
      if (row.status && !labels.has(row.status)) {
        labels.set(row.status, row.statusLabel || row.status);
      }
    }
    return [
      { value: "all", label: "全部状态" },
      ...[...labels.entries()]
        .sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right))
        .map(([value, label]: any[]) : any => ({ value, label })),
    ];
  });
  const systemLogPageSizeOptionBarOptions: OptionBarOption[] =
    systemLogPaginationConfig.pageSizeOptions.map((value?: any) : any => ({
      value,
      label: `${value} 条/页`,
    }));

  function systemLogDisplayStatusLabel(row: SystemLogRow) : any {
    return String(row.statusLabel || row.status || "unknown");
  }

  function scrollSystemLogTableToTop() : any {
    const shell: any = systemLogTableShellRef.value;
    const scroller: any = shell?.querySelector(".el-scrollbar__wrap") || shell;
    scroller?.scrollTo?.({ top: 0, behavior: "smooth" });
    systemLogScrollTop.value = 0;
  }

  function goToSystemLogNextPage() : any {
    systemLogCurrentPage.value = Math.min(
      systemLogPageCount.value,
      systemLogCurrentPage.value + 1,
    );
    scrollSystemLogTableToTop();
  }

  function goToSystemLogPreviousPage() : any {
    systemLogCurrentPage.value = Math.max(1, systemLogCurrentPage.value - 1);
    scrollSystemLogTableToTop();
  }

  function handleSystemLogTableScroll(payload: SystemLogScrollPayload) : any {
    if (typeof Event !== "undefined" && payload instanceof Event) {
      const target: any = payload.target;
      systemLogScrollTop.value =
        typeof HTMLElement !== "undefined" && target instanceof HTMLElement
          ? target.scrollTop
          : 0;
      return;
    }
    const scrollPayload: any = payload as Exclude<SystemLogScrollPayload, Event>;
    systemLogScrollTop.value = Math.max(0, Number(scrollPayload.scrollTop || 0));
  }

  function exportSystemLogRows() : any {
    const headers: any[] = [
      "logId",
      "kind",
      "target",
      "status",
      "occurredAt",
      "progressPercent",
      "stage",
      "detail",
      "error",
    ];
    const rows: any = filteredSystemLogRows.value.map((row?: any) : any => [
      row.logId,
      row.kindLabel,
      row.target,
      systemLogDisplayStatusLabel(row),
      row.occurredAt,
      row.progressPercent,
      row.stage,
      row.detail,
      row.error,
    ]);
    const csv: any = [headers, ...rows]
      .map((values?: any) : any => values.map(csvCell).join(","))
      .join("\r\n");
    const timestamp: any = formatMachineDate(new Date().toISOString(), "full").replace(/[: ]/g, "-");
    downloadTextFile(
      `meshrix-system-logs-${timestamp}.csv`,
      `\uFEFF${csv}\r\n`,
      "text/csv;charset=utf-8",
    );
  }

  // Registered inside onMounted so the URL-hydrated filter/page values (read
  // on mount by useConsoleUrlState) form the watch baseline; only later
  // filter/pageSize changes reset paging and scroll back to the top.
  onMounted((): void => {
    watch(
      [systemLogFilters, systemLogPageSize],
      () : any => {
        systemLogCurrentPage.value = 1;
        scrollSystemLogTableToTop();
      },
      { deep: true },
    );
  });
  watch(systemLogPageCount, (pageCount?: any) : any => {
    systemLogCurrentPage.value = Math.min(systemLogCurrentPage.value, pageCount);
  });

  return {
    exportSystemLogRows,
    filteredSystemLogRows,
    goToSystemLogNextPage,
    goToSystemLogPreviousPage,
    handleSystemLogTableScroll,
    paginatedSystemLogRows,
    systemLogColumnWidths,
    systemLogCurrentPage,
    systemLogDisplayStatusLabel,
    systemLogFilters,
    systemLogKindOptionBarOptions,
    systemLogPageCount,
    systemLogPageRange,
    systemLogPageSize,
    systemLogPageSizeOptionBarOptions,
    systemLogPageTotal,
    systemLogScrollTop,
    systemLogStatusOptionBarOptions,
    systemLogTableShellRef,
  };
}
