import { computed, ref, type Ref } from "vue";
import type { ClientAlignmentState, ServerConsoleState } from "../lib/types";
import type { OptionBarOption } from "../types/app";
import { downloadTextFile } from "./console-browser-effects";
import {
  clientConnectionDetail,
  clientConnectionMethodLabel,
  clientStatusLabel,
} from "@meshrix/ui-console/console-client-display-utils";
import { alignmentStateLabels } from "./console-defaults";
import { formatMachineDate, parseTime } from "./console-format-utils";

type ConsoleClientControllerOptions = {
  consoleState: Ref<ServerConsoleState | null>;
};

export function createConsoleClientController(options: ConsoleClientControllerOptions) : any {
  const clientSearchQuery: any = ref("");
  const clientStateFilter: any = ref<ClientAlignmentState | "all">("all");

  const filteredClients: any = computed(() : any =>
    [...(options.consoleState.value?.clients.items || [])].sort(
      (left?: any, right?: any) : any => parseTime(right.lastSeenAt) - parseTime(left.lastSeenAt),
    ),
  );

  const filteredClientList: any = computed(() : any => {
    const query: any = clientSearchQuery.value.trim().toLowerCase();
    const stateFilter: any = clientStateFilter.value;

    return filteredClients.value.filter((item?: any) : any => {
      if (stateFilter !== "all" && item.alignmentState !== stateFilter) {
        return false;
      }

      if (!query) {
        return true;
      }
      return (
        (item.clientLabel || "").toLowerCase().includes(query) ||
        (item.clientId || "").toLowerCase().includes(query) ||
        (item.hostname || "").toLowerCase().includes(query) ||
        (item.platform || "").toLowerCase().includes(query) ||
        (item.currentServiceUrl || "").toLowerCase().includes(query) ||
        clientConnectionMethodLabel(item).toLowerCase().includes(query) ||
        clientConnectionDetail(item).toLowerCase().includes(query) ||
        clientStatusLabel(item).toLowerCase().includes(query) ||
        (alignmentStateLabels[item.alignmentState as ClientAlignmentState] || "").includes(query)
      );
    });
  });

  const displayedClients: any = computed(() : any => filteredClients.value.slice(0, 6));
  const clientStateFilterOptionBarOptions: any = computed<OptionBarOption[]>(() : any => [
    { value: "all", label: "所有状态" },
    ...(Object.entries(alignmentStateLabels) as [string, any][]).map(([value, label]: any[]) : any => ({ value, label })),
  ]);
  const attentionClientCount: any = computed(() : any => {
    const summary: any = options.consoleState.value?.clients.summary;

    if (!summary) {
      return 0;
    }

    return (
      summary.outdatedCount +
      summary.drainingCount +
      summary.bootstrapOnlyCount +
      summary.offlineCount +
      summary.unknownCount
    );
  });
  const latestClient: any = computed(() : any => filteredClients.value[0] || null);

  function exportClients() : any {
    const exportedAt: any = new Date().toISOString();
    const payload: Record<string, any> = {
      schemaVersion: "v0.0.1:console:client-inventory-export-1",
      exportedAt,
      source: "server-console-discovery-clients",
      privacy: {
        redacted: true,
        omittedFields: [
          "clientId",
          "clientLabel",
          "hostname",
          "bootstrapUrl",
          "currentServiceUrl",
          "desiredServiceUrl",
          "currentJobServiceUrl",
          "sourceGrantId",
        ],
      },
      summary: options.consoleState.value?.clients.summary || null,
      clients: filteredClients.value.map((client?: any, index?: any) : any => ({
        clientRef: `client-${index + 1}`,
        appVersion: client.appVersion || "",
        platform: client.platform || "",
        configVersion: client.configVersion || "",
        alignmentState: client.alignmentState,
        connectionKind: client.connectionKind || "",
        connectionMethod: client.connectionMethod || "",
        connectionState: client.connectionState || "",
        connectionStatusLabel: client.connectionStatusLabel || "",
        supportsAlignment: client.supportsAlignment === true,
        busy: client.busy === true,
        firstSeenAt: client.firstSeenAt || "",
        lastSeenAt: client.lastSeenAt || "",
      })),
    };
    const timestamp: any = formatMachineDate(exportedAt, "full").replace(/[: ]/g, "-");
    downloadTextFile(
      `meshrix-clients-${timestamp}.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  }

  return {
    attentionClientCount,
    clientSearchQuery,
    clientStateFilter,
    clientStateFilterOptionBarOptions,
    displayedClients,
    exportClients,
    filteredClientList,
    filteredClients,
    latestClient,
  };
}
