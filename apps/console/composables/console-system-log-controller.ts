import { computed, ref, watch, type ComputedRef } from "vue";
import type { OptionBarOption, SystemLogRow } from "../types/app";
import { downloadTextFile } from "./console-browser-effects";
import { systemLogPaginationConfig } from "./console-defaults";
import { formatMachineDate, parseTime } from "./console-format-utils";

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

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function rowSearchText(row: SystemLogRow) {
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

function dateBoundary(value: string, endOfDay = false) {
  if (!value) {
    return endOfDay ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
}

export function createConsoleSystemLogController(
  options: ConsoleSystemLogControllerOptions,
) {
  const systemLogFilters = ref<SystemLogFilters>({
    fuzzy: "",
    kind: "all",
    status: "all",
    from: "",
    to: "",
  });
  const systemLogColumnWidths = ref({
    kind: 120,
    target: 220,
    time: 180,
    status: 130,
    progress: 120,
    stage: 160,
    detail: 260,
    error: 220,
  });
  const systemLogCurrentPage = ref(1);
  const systemLogPageSize = ref(systemLogPaginationConfig.defaultPageSize);
  const systemLogTableShellRef = ref<HTMLElement | null>(null);
  const systemLogScrollTop = ref(0);

  const filteredSystemLogRows = computed(() => {
    const fuzzy = systemLogFilters.value.fuzzy.trim().toLocaleLowerCase();
    const from = dateBoundary(systemLogFilters.value.from);
    const to = dateBoundary(systemLogFilters.value.to, true);
    return options.serverLogRows.value.filter((row) => {
      if (systemLogFilters.value.kind !== "all" && row.kindLabel !== systemLogFilters.value.kind) {
        return false;
      }
      if (systemLogFilters.value.status !== "all" && row.status !== systemLogFilters.value.status) {
        return false;
      }
      const occurredAt = parseTime(row.occurredAt || row.createdAt);
      if (Number.isFinite(from) && occurredAt < from) {
        return false;
      }
      if (Number.isFinite(to) && occurredAt > to) {
        return false;
      }
      return !fuzzy || rowSearchText(row).includes(fuzzy);
    });
  });

  const systemLogPageTotal = computed(() => filteredSystemLogRows.value.length);
  const normalizedPageSize = computed(() => Math.max(
    1,
    Math.min(systemLogPaginationConfig.maxPageSize, Number(systemLogPageSize.value) || systemLogPaginationConfig.defaultPageSize),
  ));
  const systemLogPageCount = computed(() =>
    Math.max(1, Math.ceil(systemLogPageTotal.value / normalizedPageSize.value)),
  );
  const systemLogPageRange = computed(() => ({
    start: systemLogPageTotal.value === 0
      ? 0
      : (systemLogCurrentPage.value - 1) * normalizedPageSize.value + 1,
    end: Math.min(
      systemLogPageTotal.value,
      systemLogCurrentPage.value * normalizedPageSize.value,
    ),
  }));
  const paginatedSystemLogRows = computed(() => {
    const start = (systemLogCurrentPage.value - 1) * normalizedPageSize.value;
    return filteredSystemLogRows.value.slice(start, start + normalizedPageSize.value);
  });

  const systemLogKindOptionBarOptions = computed<OptionBarOption[]>(() => [
    { value: "all", label: "全部类型" },
    ...[...new Set(options.serverLogRows.value.map((row) => row.kindLabel).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({ value, label: value })),
  ]);
  const systemLogStatusOptionBarOptions = computed<OptionBarOption[]>(() => {
    const labels = new Map<string, string>();
    for (const row of options.serverLogRows.value) {
      if (row.status && !labels.has(row.status)) {
        labels.set(row.status, row.statusLabel || row.status);
      }
    }
    return [
      { value: "all", label: "全部状态" },
      ...[...labels.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([value, label]) => ({ value, label })),
    ];
  });
  const systemLogPageSizeOptionBarOptions: OptionBarOption[] =
    systemLogPaginationConfig.pageSizeOptions.map((value) => ({
      value,
      label: `${value} 条/页`,
    }));

  function systemLogDisplayStatusLabel(row: SystemLogRow) {
    return String(row.statusLabel || row.status || "unknown");
  }

  function scrollSystemLogTableToTop() {
    const shell = systemLogTableShellRef.value;
    const scroller = shell?.querySelector<HTMLElement>(".el-scrollbar__wrap") || shell;
    scroller?.scrollTo?.({ top: 0, behavior: "smooth" });
    systemLogScrollTop.value = 0;
  }

  function goToSystemLogNextPage() {
    systemLogCurrentPage.value = Math.min(
      systemLogPageCount.value,
      systemLogCurrentPage.value + 1,
    );
    scrollSystemLogTableToTop();
  }

  function goToSystemLogPreviousPage() {
    systemLogCurrentPage.value = Math.max(1, systemLogCurrentPage.value - 1);
    scrollSystemLogTableToTop();
  }

  function handleSystemLogTableScroll(payload: SystemLogScrollPayload) {
    if (typeof Event !== "undefined" && payload instanceof Event) {
      const target = payload.target;
      systemLogScrollTop.value =
        typeof HTMLElement !== "undefined" && target instanceof HTMLElement
          ? target.scrollTop
          : 0;
      return;
    }
    const scrollPayload = payload as Exclude<SystemLogScrollPayload, Event>;
    systemLogScrollTop.value = Math.max(0, Number(scrollPayload.scrollTop || 0));
  }

  function exportSystemLogRows() {
    const headers = [
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
    const rows = filteredSystemLogRows.value.map((row) => [
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
    const csv = [headers, ...rows]
      .map((values) => values.map(csvCell).join(","))
      .join("\r\n");
    const timestamp = formatMachineDate(new Date().toISOString(), "full").replace(/[: ]/g, "-");
    downloadTextFile(
      `lico-system-logs-${timestamp}.csv`,
      `\uFEFF${csv}\r\n`,
      "text/csv;charset=utf-8",
    );
  }

  watch(
    [systemLogFilters, systemLogPageSize],
    () => {
      systemLogCurrentPage.value = 1;
      scrollSystemLogTableToTop();
    },
    { deep: true },
  );
  watch(systemLogPageCount, (pageCount) => {
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
