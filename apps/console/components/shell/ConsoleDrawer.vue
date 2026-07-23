<script setup lang="ts">
import ConsoleAuthUsersPanel from "./ConsoleAuthUsersPanel.vue";
import ConsolePreferencesPanel from "./ConsolePreferencesPanel.vue";
import ConsoleServiceDiscoveryPanel from "./ConsoleServiceDiscoveryPanel.vue";
import { createConsoleDrawerResizeController } from "../../composables/console-drawer-resize-controller";
import { useServerConsoleShellContext } from "../../composables/serverConsoleShellContext";

const {
  closeDrawer,
  drawerOpen,
  drawerTab,
  hasFeature,
  isAuthenticated,
  msg,
  openDrawer,
} = useServerConsoleShellContext();

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
    class="config-drawer"
    :class="{ open: drawerOpen, 'is-resizing': drawerResizeDragging }"
    :style="drawerResizeStyle"
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
        @click="closeDrawer()"
      >
        {{ msg.close }}
      </button>
    </header>

    <div class="drawer-tabs">
      <button
        class="drawer-tab"
        :class="{ active: drawerTab === 'preferences' }"
        type="button"
        @click="openDrawer('preferences')"
      >
        {{ msg.drawer.preferences }}
      </button>
      <button
        class="drawer-tab"
        :class="{ active: drawerTab === 'discovery' }"
        type="button"
        @click="openDrawer('discovery')"
      >
        {{ msg.drawer.serviceDiscovery }}
      </button>
      <button
        v-if="hasFeature('analysis-runtime')"
        class="drawer-tab"
        :class="{ active: drawerTab === 'users' }"
        type="button"
        @click="openDrawer('users')"
      >
        {{ msg.drawer.users }}
      </button>
    </div>

    <div class="drawer-content">
      <ConsolePreferencesPanel v-if="drawerTab === 'preferences'" />
      <ConsoleServiceDiscoveryPanel v-else-if="drawerTab === 'discovery'" />
      <ConsoleAuthUsersPanel v-else-if="drawerTab === 'users'" />
    </div>
  </aside>
</template>
