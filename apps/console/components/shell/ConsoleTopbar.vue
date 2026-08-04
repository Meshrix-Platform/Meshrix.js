<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ADMIN_ROUTE_REGISTRY } from "../../router/admin-route-registry.ts";
import { openConsoleCommandPalette, resolveAdminSectionLabel } from "../../composables/console-command-palette-controller";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";
import {
  SERVER_ADDRESS_STORAGE_EVENT,
  normalizeServerAddressUrl,
  readStoredServerAddresses,
  uniqueServerAddressStrings,
  writeStoredServerAddresses,
  type StoredServerAddresses,
} from "../../lib/console-server-addresses";

const {
  activeRouteAdminView,
  activeRouteView,
  currentUser,
  isAuthenticated,
  localizedViewTitle,
  msg,
  pageRefreshAriaLabel,
  pageRefreshBusy,
  pageRefreshTitle,
  refreshCurrentPage,
  serverAvailable,
  serviceStatusLabel,
  serviceUrl,
  sideNavCollapsed,
  sideNavOpen,
  tt,
} = useServerConsoleShellContext();

const topbarUserName = computed(() => currentUser.value?.username || currentUser.value?.displayName || "");
const breadcrumbSectionLabel = computed(() => {
  if (!isAuthenticated.value || activeRouteView.value !== "admin") {
    return "";
  }
  const entry = ADMIN_ROUTE_REGISTRY.find((candidate: any) => candidate.viewKey === activeRouteAdminView.value);
  if (!entry) {
    return "";
  }
  return resolveAdminSectionLabel(entry.section, msg.value);
});
const serviceAddressMenuRef = ref<HTMLElement | null>(null);
const serviceAddressMenuOpen = ref(false);
const storedServerAddresses = ref<StoredServerAddresses>(readStoredServerAddresses());
const normalizedCurrentServiceUrl = computed(() => normalizeServerAddressUrl(serviceUrl.value));
const normalizedStoredActiveUrl = computed(() => normalizeServerAddressUrl(storedServerAddresses.value.activeUrl));

const serviceAddressOptions = computed(() =>
  uniqueServerAddressStrings([
    ...storedServerAddresses.value.addresses,
    ...(normalizedStoredActiveUrl.value ? [normalizedStoredActiveUrl.value] : []),
    ...(normalizedCurrentServiceUrl.value ? [normalizedCurrentServiceUrl.value] : []),
  ]).map((url: any) => ({
    url,
    isCurrent: url === normalizedCurrentServiceUrl.value,
    isStoredActive: url === normalizedStoredActiveUrl.value,
  })),
);
const hasMultipleServiceAddresses = computed(() => serviceAddressOptions.value.length > 1);

function toggleSideNav() {
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches) {
    sideNavCollapsed.value = false;
    sideNavOpen.value = !sideNavOpen.value;
    return;
  }
  sideNavCollapsed.value = !sideNavCollapsed.value;
}

function refreshStoredServerAddresses() {
  storedServerAddresses.value = readStoredServerAddresses();
}

function closeServiceAddressMenu() {
  serviceAddressMenuOpen.value = false;
}

function toggleServiceAddressMenu() {
  if (!isAuthenticated.value) {
    return;
  }
  refreshStoredServerAddresses();
  if (!hasMultipleServiceAddresses.value) {
    return;
  }
  serviceAddressMenuOpen.value = !serviceAddressMenuOpen.value;
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!serviceAddressMenuOpen.value) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node) || !serviceAddressMenuRef.value?.contains(target)) {
    closeServiceAddressMenu();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeServiceAddressMenu();
  }
}

function switchServiceAddress(url: string) {
  const nextUrl = normalizeServerAddressUrl(url);
  const currentUrl = normalizedCurrentServiceUrl.value;
  if (!nextUrl) {
    return;
  }

  const addresses = uniqueServerAddressStrings([
    ...storedServerAddresses.value.addresses,
    ...(currentUrl ? [currentUrl] : []),
    nextUrl,
  ]);

  if (nextUrl === currentUrl) {
    writeStoredServerAddresses({ activeUrl: nextUrl, addresses });
    refreshStoredServerAddresses();
    closeServiceAddressMenu();
    return;
  }

  writeStoredServerAddresses({ activeUrl: nextUrl, addresses });
  refreshStoredServerAddresses();

  if (typeof window !== "undefined") {
    const destination = new URL(nextUrl);
    destination.hash = window.location.hash || "#/";
    window.location.assign(destination.toString());
  }
}

onMounted(() => {
  refreshStoredServerAddresses();
  window.addEventListener(SERVER_ADDRESS_STORAGE_EVENT, refreshStoredServerAddresses);
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener(SERVER_ADDRESS_STORAGE_EVENT, refreshStoredServerAddresses);
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeydown);
});
</script>

<template>
  <header class="topbar" :class="{ 'is-disabled': !isAuthenticated }" :aria-disabled="!isAuthenticated">
    <div class="topbar-actions" :aria-label="tt('页面操作')">
      <button
        class="topbar-sidebar-toggle"
        type="button"
        :disabled="!isAuthenticated"
        :aria-expanded="!sideNavCollapsed"
        :aria-label="sideNavCollapsed ? tt('展开侧边栏') : tt('收起侧边栏')"
        :title="sideNavCollapsed ? tt('展开侧边栏') : tt('收起侧边栏')"
        @click="toggleSideNav"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      <button
        class="tool-button tool-button-ghost tool-button-icon"
        type="button"
        :title="pageRefreshTitle"
        :disabled="!isAuthenticated || pageRefreshBusy"
        :aria-label="pageRefreshAriaLabel"
        @click="refreshCurrentPage"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ 'is-spinning': pageRefreshBusy }" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
          <path d="M8 16H3v5"/>
        </svg>
      </button>
      <button
        class="tool-button tool-button-ghost topbar-palette-trigger"
        type="button"
        :title="tt('打开命令面板')"
        :aria-label="tt('打开命令面板')"
        :disabled="!isAuthenticated"
        @click="openConsoleCommandPalette"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>
    </div>

    <div class="topbar-heading">
      <nav class="topbar-breadcrumb" :aria-label="tt('当前位置')">
        <template v-if="breadcrumbSectionLabel">
          <span class="topbar-breadcrumb-section">{{ breadcrumbSectionLabel }}</span>
          <span class="topbar-breadcrumb-separator" aria-hidden="true">/</span>
        </template>
        <h2 class="topbar-page-title">{{ isAuthenticated ? localizedViewTitle : tt('登录') }}</h2>
      </nav>
    </div>

    <div class="topbar-status" :aria-label="tt('当前状态')">
      <div ref="serviceAddressMenuRef" class="service-address-menu">
        <button
          class="url-badge service-url-badge service-url-trigger"
          :class="[
            serverAvailable ? 'is-available' : 'is-unavailable',
            { 'has-address-options': hasMultipleServiceAddresses },
          ]"
          type="button"
          :title="hasMultipleServiceAddresses ? tt('切换后端服务地址') : serviceStatusLabel"
          :aria-label="`${serviceStatusLabel}: ${serviceUrl}`"
          :aria-haspopup="hasMultipleServiceAddresses ? 'listbox' : undefined"
          :aria-expanded="hasMultipleServiceAddresses ? serviceAddressMenuOpen : undefined"
          @click="toggleServiceAddressMenu"
        >
          <span class="service-status-dot" aria-hidden="true"></span>
          <span class="service-url-text">{{ serviceUrl }}</span>
          <svg
            v-if="hasMultipleServiceAddresses"
            class="service-url-chevron"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div
          v-if="serviceAddressMenuOpen"
          class="service-address-dropdown"
          role="listbox"
          :aria-label="tt('后端服务地址')"
        >
          <button
            v-for="option in serviceAddressOptions"
            :key="option.url"
            class="service-address-option"
            type="button"
            role="option"
            :aria-selected="option.isCurrent"
            @click="switchServiceAddress(option.url)"
          >
            <span
              class="service-address-option-dot"
              :class="{ active: option.isCurrent }"
              aria-hidden="true"
            ></span>
            <span class="service-address-option-url">{{ option.url }}</span>
            <span v-if="option.isCurrent" class="service-address-option-state">{{ tt("当前") }}</span>
          </button>
        </div>
      </div>
      <span v-if="topbarUserName" class="identity-chip" :title="topbarUserName">
        <span class="identity-chip-text">{{ topbarUserName }}</span>
      </span>
    </div>
  </header>
</template>

<style scoped>
.is-spinning {
  animation: spin 1s linear infinite;
}

.topbar-palette-trigger {
  min-width: 148px;
  justify-content: flex-start;
}

.topbar-breadcrumb {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.topbar-breadcrumb-section {
  flex: none;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.topbar-breadcrumb-separator {
  flex: none;
  color: var(--text-disabled);
  font-size: var(--text-sm);
}

.service-address-menu {
  position: relative;
  min-width: 0;
}

.service-url-trigger {
  display: inline-flex;
  width: 100%;
  border: 1px solid var(--border-subtle);
  cursor: default;
  appearance: none;
}

.service-url-trigger.has-address-options {
  cursor: pointer;
}

.service-url-trigger.has-address-options:hover,
.service-url-trigger.has-address-options:focus-visible {
  border-color: var(--brand-border);
  background: var(--brand-tint);
  outline: none;
}

.service-url-chevron {
  width: 13px;
  height: 13px;
  margin-left: 4px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.8;
}

.service-address-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
  display: grid;
  width: min(360px, 82vw);
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}

.service-address-option {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  align-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
}

.service-address-option:hover,
.service-address-option:focus-visible {
  background: var(--bg-subtle);
  color: var(--text-primary);
  outline: none;
}

.service-address-option[aria-selected="true"] {
  background: var(--brand-subtle);
  color: var(--brand);
}

.service-address-option-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--text-muted);
}

.service-address-option-dot.active {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-tint);
}

.service-address-option-url {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.service-address-option-state {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
}

</style>
