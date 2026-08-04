<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ADMIN_ROUTE_REGISTRY } from "../../router/admin-route-registry.ts";
import { isAdminPluginConsoleEntry } from "../../router/plugin-console-routes";
import {
  closeConsoleCommandPalette,
  filterConsoleCommandPaletteItems,
  groupConsoleCommandPaletteItems,
  resolveAdminSectionLabel,
  resolveAdminViewLabel,
  toggleConsoleCommandPalette,
  useConsoleCommandPalette,
  type ConsoleCommandPaletteItem,
} from "../../composables/console-command-palette-controller";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

defineOptions({ name: "ConsoleCommandPalette" });

const {
  canAccessAdminView,
  canAccessView,
  consoleState,
  isAuthenticated,
  msg,
  openAdmin,
  switchView,
  tt,
} = useServerConsoleShellContext();

const { paletteOpen, query, activeIndex } = useConsoleCommandPalette();

const inputRef = ref<HTMLInputElement | null>(null);

const items = computed<ConsoleCommandPaletteItem[]>(() => {
  const messages = msg.value;
  const primaryLabel = tt("主导航");
  const list: ConsoleCommandPaletteItem[] = [];

  if (canAccessView("dashboard")) {
    list.push({
      id: "dashboard",
      label: messages.nav.dashboard,
      sectionLabel: primaryLabel,
      keywords: ["dashboard", "#/"],
      activate: () => switchView("dashboard"),
    });
  }
  if (canAccessView("approval")) {
    list.push({
      id: "approval",
      label: messages.nav.approvalFlow,
      sectionLabel: primaryLabel,
      keywords: ["approval", "#/approval"],
      activate: () => switchView("approval"),
    });
  }
  if (canAccessView("workspaces")) {
    list.push({
      id: "workspaces",
      label: messages.nav.workspaces,
      sectionLabel: primaryLabel,
      keywords: ["workspaces", "#/workspaces"],
      activate: () => switchView("workspaces"),
    });
  }
  if (canAccessAdminView("operationPermission")) {
    list.push({
      id: "operationPermission",
      label: messages.nav.operationPermission,
      sectionLabel: primaryLabel,
      keywords: ["operation", "permission", "operation-permission"],
      activate: () => openAdmin("operationPermission"),
    });
  }

  for (const entry of ADMIN_ROUTE_REGISTRY) {
    if (entry.section === "primary" || !canAccessAdminView(entry.viewKey)) {
      continue;
    }
    list.push({
      id: entry.viewKey,
      label: resolveAdminViewLabel(entry.viewKey, messages),
      sectionLabel: resolveAdminSectionLabel(entry.section, messages),
      keywords: [entry.viewKey, entry.slug, entry.description || ""],
      activate: () => openAdmin(entry.viewKey),
    });
  }

  const pluginEntries = consoleState.value?.features?.plugins?.consoleEntries || [];
  for (const entry of pluginEntries) {
    if (!isAdminPluginConsoleEntry(entry) || !canAccessAdminView(entry.viewKey)) {
      continue;
    }
    list.push({
      id: `plugin:${entry.id}`,
      label: entry.label || entry.id,
      sectionLabel: "Plugins",
      keywords: [entry.viewKey, entry.routePath || ""],
      activate: () => openAdmin(entry.viewKey),
    });
  }

  return list;
});

const filteredItems = computed(() => filterConsoleCommandPaletteItems(items.value, query.value));

const groupedItems = computed(() => groupConsoleCommandPaletteItems(filteredItems.value));

watch(filteredItems, () => {
  activeIndex.value = 0;
});

watch(paletteOpen, async (open: any) => {
  if (!open) {
    return;
  }
  await nextTick();
  inputRef.value?.focus({ preventScroll: true });
});

function itemIndex(item: ConsoleCommandPaletteItem) {
  return filteredItems.value.indexOf(item);
}

function activateItem(item: ConsoleCommandPaletteItem | undefined) {
  if (!item) {
    return;
  }
  closeConsoleCommandPalette();
  void item.activate();
}

function handleInputKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, filteredItems.value.length - 1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    activateItem(filteredItems.value[activeIndex.value] ?? filteredItems.value[0]);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeConsoleCommandPalette();
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (!isAuthenticated.value) {
      return;
    }
    event.preventDefault();
    toggleConsoleCommandPalette();
    return;
  }
  if (event.key === "Escape" && paletteOpen.value) {
    closeConsoleCommandPalette();
  }
}

onMounted(() => {
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleDocumentKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="console-palette">
      <div
        v-if="paletteOpen"
        class="console-palette-backdrop"
        @click.self="closeConsoleCommandPalette"
      >
        <div
          class="console-palette"
          role="dialog"
          aria-modal="true"
          :aria-label="tt('命令面板')"
        >
          <input
            ref="inputRef"
            v-model="query"
            class="console-palette-input"
            type="text"
            :placeholder="tt('搜索页面或功能…')"
            :aria-label="tt('搜索页面或功能')"
            autocomplete="off"
            spellcheck="false"
            @keydown="handleInputKeydown"
          />

          <div class="console-palette-results" role="listbox" :aria-label="tt('导航')">
            <p v-if="!filteredItems.length" class="console-palette-empty">{{ tt("无匹配页面") }}</p>
            <section v-for="group in groupedItems" :key="group.sectionLabel" class="console-palette-group">
              <p v-if="group.sectionLabel" class="console-palette-group-title">{{ group.sectionLabel }}</p>
              <button
                v-for="item in group.items"
                :key="item.id"
                class="console-palette-item"
                :class="{ active: itemIndex(item) === activeIndex }"
                type="button"
                role="option"
                :aria-selected="itemIndex(item) === activeIndex"
                @mouseenter="activeIndex = itemIndex(item)"
                @click="activateItem(item)"
              >
                <span class="console-palette-item-label">{{ item.label }}</span>
                <span class="console-palette-item-section">{{ item.sectionLabel }}</span>
              </button>
            </section>
          </div>

          <footer class="console-palette-footer" aria-hidden="true">
            <span>↑↓ {{ tt("移动") }}</span>
            <span>↵ {{ tt("打开") }}</span>
            <span>esc {{ tt("关闭") }}</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.console-palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-top);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 18vh var(--space-4) var(--space-4);
  background: var(--backdrop);
}

.console-palette {
  width: min(560px, calc(100vw - 32px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  background: var(--bg-surface);
  box-shadow: var(--shadow-xl);
}

.console-palette-input {
  height: 46px;
  padding: 0 var(--space-4);
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-2xl);
  outline: none;
}

.console-palette-input::placeholder {
  color: var(--text-disabled);
}

.console-palette-results {
  max-height: min(380px, 52vh);
  overflow-y: auto;
  padding: var(--space-2);
}

.console-palette-empty {
  margin: 0;
  padding: var(--space-6) var(--space-4);
  color: var(--text-muted);
  font-size: var(--text-base);
  text-align: center;
}

.console-palette-group-title {
  margin: 0;
  padding: var(--space-2) var(--space-2-5) var(--space-1);
  color: var(--text-muted);
  font-size: var(--text-2xs);
  font-weight: var(--font-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.console-palette-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-height: 38px;
  padding: 0 var(--space-2-5);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-std),
    color var(--dur-fast) var(--ease-std);
}

.console-palette-item.active {
  background: var(--brand-tint);
  color: var(--text-primary);
}

.console-palette-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-palette-item-section {
  flex: none;
  color: var(--text-disabled);
  font-size: var(--text-xs);
}

.console-palette-footer {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-disabled);
  font-size: var(--text-xs);
}

.console-palette-enter-active,
.console-palette-leave-active {
  transition: opacity var(--dur-base) var(--ease-std);
}

.console-palette-enter-active .console-palette,
.console-palette-leave-active .console-palette {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.console-palette-enter-from,
.console-palette-leave-to {
  opacity: 0;
}

.console-palette-enter-from .console-palette,
.console-palette-leave-to .console-palette {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

@media (max-width: 520px) {
  .console-palette-backdrop {
    padding-top: 10vh;
  }
}

@media (prefers-reduced-motion: reduce) {
  .console-palette-enter-active,
  .console-palette-leave-active,
  .console-palette-enter-active .console-palette,
  .console-palette-leave-active .console-palette,
  .console-palette-item {
    transition: none;
  }
}
</style>
