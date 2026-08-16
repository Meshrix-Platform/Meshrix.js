<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { useConsoleSideNavContext } from "../../composables/consoleSideNavContext";
import ConsoleSideNavBackdrop from "./side-nav/ConsoleSideNavBackdrop.vue";
import ConsoleSideNavBrand from "./side-nav/ConsoleSideNavBrand.vue";
import ConsoleSideNavFooter from "./side-nav/ConsoleSideNavFooter.vue";
import ConsoleSideNavOperationsSection from "./side-nav/ConsoleSideNavOperationsSection.vue";
import ConsoleSideNavPermissionSection from "./side-nav/ConsoleSideNavPermissionSection.vue";
import ConsoleSideNavPrimaryLinks from "./side-nav/ConsoleSideNavPrimaryLinks.vue";
import ConsoleSideNavServiceSection from "./side-nav/ConsoleSideNavServiceSection.vue";
import ConsoleSideNavSystemSection from "./side-nav/ConsoleSideNavSystemSection.vue";
import ConsoleSideNavToolsSection from "./side-nav/ConsoleSideNavToolsSection.vue";
import ConsoleSideNavVersionSection from "./side-nav/ConsoleSideNavVersionSection.vue";

defineOptions({ name: "ConsoleSideNav" });
const {
  consoleState,
  isAuthenticated,
  setSideNavWidth,
  sideNavCollapsed,
  sideNavMinWidth,
  sideNavOpen,
  sideNavWidth,
  tt,
} = useConsoleSideNavContext();

/* Nav sections are gated on scopes + features from async console state;
   show a skeleton instead of letting sections pop in one by one. */
const showNavSkeleton = computed(() => isAuthenticated.value && !consoleState.value);

let stopResizeListeners: (() => void) | null = null;

function stopSideNavResize() {
  stopResizeListeners?.();
  stopResizeListeners = null;
  document.body.classList.remove("is-resizing-side-nav");
}

function startSideNavResize(event: PointerEvent) {
  if (!isAuthenticated.value || sideNavCollapsed.value || event.button !== 0) {
    return;
  }
  event.preventDefault();
  stopSideNavResize();

  const target = event.currentTarget as HTMLElement | null;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startWidth = sideNavWidth.value;

  target?.setPointerCapture?.(pointerId);
  document.body.classList.add("is-resizing-side-nav");

  const handlePointerMove = (moveEvent: PointerEvent) => {
    setSideNavWidth(startWidth + moveEvent.clientX - startX);
  };
  const handlePointerUp = () => {
    target?.releasePointerCapture?.(pointerId);
    stopSideNavResize();
  };

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp, { once: true });
  window.addEventListener("pointercancel", handlePointerUp, { once: true });

  stopResizeListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };
}

function handleSideNavResizeKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 16;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setSideNavWidth(sideNavWidth.value - step);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setSideNavWidth(sideNavWidth.value + step);
  } else if (event.key === "Home") {
    event.preventDefault();
    setSideNavWidth(sideNavMinWidth);
  }
}

onBeforeUnmount(stopSideNavResize);
</script>

<template>
  <aside
    class="side-nav"
    :class="{
      'is-open': sideNavOpen,
      'is-collapsed': sideNavCollapsed,
      'is-disabled': !isAuthenticated,
    }"
    :aria-disabled="!isAuthenticated"
  >
    <div class="side-nav-primary" :inert="!isAuthenticated">
      <ConsoleSideNavBrand />
      <nav class="side-nav-links">
        <div v-if="showNavSkeleton" class="side-nav-skeleton" aria-hidden="true">
          <span class="sk sk-title" />
          <span class="sk sk-text" />
          <span class="sk sk-text" />
          <span class="sk sk-text-sm" />
          <span class="sk sk-text" />
          <span class="sk sk-text-sm" />
        </div>
        <template v-else>
          <ConsoleSideNavPrimaryLinks />
          <ConsoleSideNavServiceSection />
          <ConsoleSideNavToolsSection />
          <ConsoleSideNavPermissionSection />
          <ConsoleSideNavSystemSection />
          <ConsoleSideNavOperationsSection />
          <ConsoleSideNavVersionSection />
        </template>
      </nav>

      <ConsoleSideNavFooter />
    </div>
    <div
      v-if="isAuthenticated && !sideNavCollapsed"
      class="side-nav-resize"
      role="separator"
      aria-orientation="vertical"
      :aria-valuemin="sideNavMinWidth"
      :aria-valuenow="sideNavWidth"
      tabindex="0"
      :title="tt('拖拽调整侧边栏宽度')"
      @pointerdown="startSideNavResize"
      @keydown="handleSideNavResizeKeydown"
    ></div>
  </aside>

  <ConsoleSideNavBackdrop v-if="isAuthenticated && sideNavOpen" />
</template>
