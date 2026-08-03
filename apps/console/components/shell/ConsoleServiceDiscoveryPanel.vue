<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useServerConsoleShellContext } from "../../composables/serverConsoleShellContext";
import {
  normalizeServerAddressUrl,
  probeServerAddressUrl,
  readStoredServerAddresses,
  uniqueServerAddressStrings,
  writeStoredServerAddresses,
} from "../../lib/console-server-addresses";
import ConsoleServerAddressRow from "./service-discovery/ConsoleServerAddressRow.vue";
import ConsoleServiceDiscoverySaveBar from "./service-discovery/ConsoleServiceDiscoverySaveBar.vue";
import ConsoleServiceIdentityFields from "./service-discovery/ConsoleServiceIdentityFields.vue";
import { createServerAddressRow } from "./service-discovery/server-address-rows";
import type { ServerAddressRow } from "./service-discovery/types";

const {
  isBusy,
  consoleState,
  discoveryDraft,
  error,
  msg,
  serverAvailable,
} = useServerConsoleShellContext();

const serviceIdDisplay = computed(() => discoveryDraft.value.serverId || msg.value.drawer.autoDetected);
const serviceLabelDisplay = computed(() => discoveryDraft.value.serverLabel || msg.value.drawer.autoDetected);

const serverAddressRows = ref<ServerAddressRow[]>([]);
const selectedServerUrl = ref("");
const localSaveMessage = ref("");

const currentDiscoveryUrl = computed(() =>
  discoveryDraft.value.activeServiceUrl ||
  discoveryDraft.value.advertisedBaseUrl ||
  discoveryDraft.value.bootstrapBaseUrl ||
  consoleState.value?.server.url ||
  "",
);

const connectedServerUrl = computed(() =>
  serverAvailable.value ? normalizeServerAddressUrl(consoleState.value?.server.url || currentDiscoveryUrl.value) : "",
);

const selectedServerAddressRow = computed(() => {
  const selectedUrl = normalizeServerAddressUrl(selectedServerUrl.value);
  if (!selectedUrl) {
    return null;
  }
  return serverAddressRows.value.find((row: any) => normalizeServerAddressUrl(row.url) === selectedUrl) || null;
});

function persistServerAddressRows() {
  const addresses = uniqueServerAddressStrings(
    serverAddressRows.value.map((row: any) => row.url.trim()).filter(Boolean),
  );
  writeStoredServerAddresses({
    activeUrl: selectedServerUrl.value.trim(),
    addresses,
  });
}

function hydrateServerAddressRows() {
  const stored = readStoredServerAddresses();
  const currentUrl = normalizeServerAddressUrl(currentDiscoveryUrl.value);
  const storedActiveUrl = normalizeServerAddressUrl(stored.activeUrl);
  const activeUrl = storedActiveUrl || currentUrl;
  const existingRows = new Map(
    serverAddressRows.value
      .map((row: any) => [normalizeServerAddressUrl(row.url), row] as const)
      .filter(([url]: readonly any[]) => Boolean(url)),
  );
  const addresses = uniqueServerAddressStrings([
    ...stored.addresses,
    ...(currentUrl ? [currentUrl] : []),
    ...(activeUrl ? [activeUrl] : []),
  ]);

  serverAddressRows.value = (addresses.length ? addresses : [""]).map((address: any) => {
    const normalizedAddress = normalizeServerAddressUrl(address);
    const existingRow = normalizedAddress ? existingRows.get(normalizedAddress) : null;
    const isConnectedAddress =
      Boolean(normalizedAddress) &&
      normalizedAddress === connectedServerUrl.value &&
      serverAvailable.value;

    if (existingRow) {
      if (isConnectedAddress) {
        existingRow.validationStatus = "available";
        existingRow.validationMessage = "当前已连接";
      }
      return existingRow;
    }

    return createServerAddressRow(
      address,
      isConnectedAddress ? "available" : "idle",
      isConnectedAddress ? "当前已连接" : "",
    );
  });

  selectedServerUrl.value = activeUrl || normalizeServerAddressUrl(serverAddressRows.value[0]?.url);
}

function addServerAddressRow() {
  serverAddressRows.value.push(createServerAddressRow());
  localSaveMessage.value = "";
  persistServerAddressRows();
}

function removeServerAddressRow(row: ServerAddressRow) {
  if (serverAddressRows.value.length <= 1) {
    return;
  }

  const removedUrl = normalizeServerAddressUrl(row.url);
  const wasSelected = Boolean(removedUrl && removedUrl === normalizeServerAddressUrl(selectedServerUrl.value));
  serverAddressRows.value = serverAddressRows.value.filter((item: any) => item.id !== row.id);
  if (wasSelected) {
    selectedServerUrl.value = normalizeServerAddressUrl(serverAddressRows.value[0]?.url) || "";
  }

  localSaveMessage.value = "已删除服务端地址。";
  persistServerAddressRows();
}

function handleAddressInput(row: ServerAddressRow) {
  const normalizedSelectedUrl = normalizeServerAddressUrl(selectedServerUrl.value);
  const normalizedRowUrl = normalizeServerAddressUrl(row.url);

  if (!normalizedRowUrl || normalizedRowUrl !== normalizedSelectedUrl) {
    row.validationStatus = "idle";
    row.validationMessage = "";
  }
  if (normalizedSelectedUrl && normalizedRowUrl !== normalizedSelectedUrl && selectedServerAddressRow.value === row) {
    selectedServerUrl.value = "";
  }

  localSaveMessage.value = "";
  persistServerAddressRows();
}

function handleRowUrlInput(row: ServerAddressRow, value: string) {
  row.url = value;
  handleAddressInput(row);
}

function isSelectedServerAddress(row: ServerAddressRow) {
  const selectedUrl = normalizeServerAddressUrl(selectedServerUrl.value);
  return Boolean(selectedUrl) && normalizeServerAddressUrl(row.url) === selectedUrl;
}

function selectServerAddress(row: ServerAddressRow) {
  const canSwitch =
    isSelectedServerAddress(row) ||
    (row.validationStatus === "available" && Boolean(normalizeServerAddressUrl(row.url)));
  if (!canSwitch) {
    row.validationMessage = "验证通过后才能切换";
    localSaveMessage.value = "";
    return;
  }

  const nextUrl = normalizeServerAddressUrl(row.url);
  if (!nextUrl) {
    row.validationStatus = "unavailable";
    row.validationMessage = "地址格式无效";
    return;
  }

  selectedServerUrl.value = nextUrl;
  localSaveMessage.value = "已切换本页绑定地址。";
  persistServerAddressRows();
}

function sameAsCurrentConnectedBackend(nextUrl: string) {
  return Boolean(nextUrl && connectedServerUrl.value && nextUrl === connectedServerUrl.value);
}

async function validateServerAddress(row: ServerAddressRow) {
  const nextUrl = normalizeServerAddressUrl(row.url);
  localSaveMessage.value = "";

  if (!nextUrl) {
    row.validationStatus = "unavailable";
    row.validationMessage = "地址格式无效";
    persistServerAddressRows();
    return;
  }

  if (sameAsCurrentConnectedBackend(nextUrl)) {
    row.validationStatus = "available";
    row.validationMessage = "当前已连接";
    persistServerAddressRows();
    return;
  }

  row.validationStatus = "checking";
  row.validationMessage = "正在验证";

  if (await probeServerAddressUrl(nextUrl)) {
    row.url = nextUrl;
    row.validationStatus = "available";
    row.validationMessage = "验证通过";
  } else {
    row.validationStatus = "unavailable";
    row.validationMessage = "无法连接";
  }
  persistServerAddressRows();
}

function saveServerDiscovery() {
  const selectedRow = selectedServerAddressRow.value;
  const selectedUrl = normalizeServerAddressUrl(selectedRow?.url || selectedServerUrl.value);

  error.value = "";
  persistServerAddressRows();

  if (!selectedUrl || !selectedRow || selectedRow.validationStatus !== "available") {
    localSaveMessage.value = "已保存到本浏览器；地址验证通过后才能切换。";
    return;
  }

  selectedServerUrl.value = selectedUrl;
  persistServerAddressRows();
  localSaveMessage.value = "已保存本页绑定地址。";
}

watch(
  [currentDiscoveryUrl, connectedServerUrl, serverAvailable],
  hydrateServerAddressRows,
  { immediate: true },
);
</script>

<template>
  <form class="drawer-panel" @submit.prevent="saveServerDiscovery">
    <div class="panel-header">
      <h4>{{ msg.drawer.serviceDiscovery }}</h4>
    </div>

    <ConsoleServiceIdentityFields
      :service-id-label="msg.drawer.serviceId"
      :service-id-value="serviceIdDisplay"
      :service-label-label="msg.drawer.serviceLabel"
      :service-label-value="serviceLabelDisplay"
    />

    <section class="server-address-manager">
      <div class="server-address-heading">
        <span>{{ msg.drawer.serverUrl }}</span>
      </div>

      <div class="server-address-list">
        <ConsoleServerAddressRow
          v-for="(row, index) in serverAddressRows"
          :key="row.id"
          :row="row"
          :index="index"
          :selected="isSelectedServerAddress(row)"
          @select="selectServerAddress"
          @url-input="handleRowUrlInput"
          @validate="validateServerAddress"
          @add="addServerAddressRow"
          @remove="removeServerAddressRow"
        />
      </div>
    </section>

    <ConsoleServiceDiscoverySaveBar
      :saving="isBusy('discovery')"
      :save-label="msg.drawer.saveDiscovery"
      :saving-label="msg.drawer.saving"
      :message="localSaveMessage"
    />
  </form>
</template>

<style scoped>
.server-address-manager {
  display: grid;
  gap: var(--space-2);
}

.server-address-heading {
  color: var(--text-secondary);
  font-size: var(--text-md);
  font-weight: 600;
}

.server-address-list {
  display: grid;
  gap: var(--space-2);
}
</style>
