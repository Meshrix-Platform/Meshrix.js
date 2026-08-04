<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import ConsoleAuthUsersPanel from "./ConsoleAuthUsersPanel.vue";
import ConsolePreferencesPanel from "./ConsolePreferencesPanel.vue";
import ConsoleServiceDiscoveryPanel from "./ConsoleServiceDiscoveryPanel.vue";
import MeshrixTabs, { type MeshrixTab } from "../MeshrixTabs.vue";
import { createConsoleDrawerResizeController } from "../../composables/console-drawer-resize-controller";
import { createConsoleOverlayController } from "../../composables/console-overlay-controller";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";
import { useConsoleUrlState } from "../../composables/use-console-url-state";

const {
  closeDrawer,
  drawerOpen,
  drawerTab,
  hasFeature,
  isAuthenticated,
  msg,
  openDrawer,
} = useServerConsoleShellContext();

// URL-addressable drawer tab: context tab clicks drive the query, and query
// changes (mount read, back/forward) drive the context through openDrawer so
// its side effects (opening the drawer) run too.
const drawerUrlTab: Ref<string> = useConsoleUrlState("drawer.tab", "preferences");
watch(drawerTab, (tab: string): void => {
  if (tab !== drawerUrlTab.value) {
    drawerUrlTab.value = tab;
  }
});
watch(drawerUrlTab, (tab: string): void => {
  if (tab !== drawerTab.value) {
    openDrawer(tab);
  }
});

// The aside stays mounted for the whole authenticated session and hides only
// via transform, so the overlay contract runs on drawerOpen transitions;
// inert (template) keeps the closed drawer out of the tab order.
const drawerRef = ref<HTMLElement | null>(null);
const drawerOverlay = createConsoleOverlayController({
  root: drawerRef,
  open: drawerOpen,
  onClose: () : any => closeDrawer(),
  initialFocus: "cancel-safe",
});
watch(
  drawerOpen,
  (isOpen: boolean) : void => {
    if (isOpen) {
      void drawerOverlay.activate();
    } else {
      drawerOverlay.deactivate();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() : void => drawerOverlay.deactivate());

const drawerTabs: ComputedRef<MeshrixTab[]> = computed(() : MeshrixTab[] => {
  const tabs: MeshrixTab[] = [
    { key: "preferences", label: msg.value.drawer.preferences },
    { key: "discovery", label: msg.value.drawer.serviceDiscovery },
  ];
  if (hasFeature("analysis-runtime")) {
    tabs.push({ key: "users", label: msg.value.drawer.users });
  }
  return tabs;
});

// Deterministic tab/panel linkage: MeshrixTabs renders meshrix-tab-<key> and
// aria-controls to these ids; the single content region swaps id/labelledby
// with the active tab.
const drawerPanelIds: Record<string, string> = {
  preferences: "drawer-panel-preferences",
  discovery: "drawer-panel-discovery",
  users: "drawer-panel-users",
};

const {
  drawerResizeDragging,
  drawerResizeStyle,
  drawerResizeValueMax,
  drawerResizeValueMin,
  drawerWidth,
  handleDrawerResizeKeydown,
  startDrawerResize,
} = createConsoleDrawerResizeController();
</script>

<template>
  <Transition name="drawer-backdrop">
    <div v-if="isAuthenticated && drawerOpen" class="drawer-backdrop" @click="closeDrawer()"></div>
  </Transition>

  <aside
    v-if="isAuthenticated"
    ref="drawerRef"
    class="config-drawer"
    :class="{ open: drawerOpen, 'is-resizing': drawerResizeDragging }"
    :style="drawerResizeStyle"
    role="dialog"
    :aria-modal="drawerOpen"
    :aria-label="msg.overlay.drawerTitle"
    :inert="!drawerOpen"
    tabindex="-1"
  >
    <button
      class="config-drawer-resize-handle"
      type="button"
      role="separator"
      aria-orientation="vertical"
      :aria-label="msg.drawer.resizeHandle"
      :aria-valuemin="drawerResizeValueMin"
      :aria-valuemax="drawerResizeValueMax"
      :aria-valuenow="drawerWidth"
      :disabled="!drawerOpen"
      :tabindex="drawerOpen ? 0 : -1"
      @keydown="handleDrawerResizeKeydown"
      @pointerdown="startDrawerResize"
    ></button>

    <header class="drawer-header">
      <div>
        <h3>{{ msg.drawer.title }}</h3>
      </div>
      <button
        class="tool-button tool-button-ghost"
        type="button"
        data-overlay-cancel-safe
        @click="closeDrawer()"
      >
        {{ msg.close }}
      </button>
    </header>

    <div class="drawer-tabs">
      <MeshrixTabs
        :model-value="drawerTab"
        :tabs="drawerTabs"
        :panel-ids="drawerPanelIds"
        size="small"
        :aria-label="msg.drawer.title"
        @change="openDrawer"
      />
    </div>

    <div
      class="drawer-content"
      role="tabpanel"
      :id="drawerPanelIds[drawerTab]"
      :aria-labelledby="`meshrix-tab-${drawerTab}`"
    >
      <ConsolePreferencesPanel v-if="drawerTab === 'preferences'" />
      <ConsoleServiceDiscoveryPanel v-else-if="drawerTab === 'discovery'" />
      <ConsoleAuthUsersPanel v-else-if="drawerTab === 'users'" />
    </div>
  </aside>
</template>
