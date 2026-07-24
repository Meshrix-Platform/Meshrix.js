<script setup lang="ts">
import { computed, ref, unref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConsoleCommandPalette from "./components/shell/ConsoleCommandPalette.vue";
import ConsoleConfirmDialog from "./components/ConsoleConfirmDialog.vue";
import ConsoleToastHost from "./components/ConsoleToastHost.vue";
import ConsoleDrawer from "./components/shell/ConsoleDrawer.vue";
import ConsoleSideNav from "./components/shell/ConsoleSideNav.vue";
import ConsoleSideNavDirectory from "./components/shell/side-nav/ConsoleSideNavDirectory.vue";
import ConsoleTopbar from "./components/shell/ConsoleTopbar.vue";
import ServerPathPickerDialog from "./components/shell/ServerPathPickerDialog.vue";
import { createConsoleSideNavContext, provideConsoleSideNavContext } from "./composables/consoleSideNavContext";
import { provideServerConsoleShell } from "./composables/serverConsoleShellContext";
import { useServerConsoleShell } from "./composables/useServerConsoleShell";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "./i18n/console";

const shell = useServerConsoleShell();
provideServerConsoleShell(shell);
const sideNav = createConsoleSideNavContext(shell);
provideConsoleSideNavContext(sideNav);
const route = useRoute();
const router = useRouter();
const routerReady = ref(false);
void router.isReady().then(() => {
  routerReady.value = true;
});

const {
  consoleBootstrapping,
  activeConsoleFeatureIds,
  canAccessRouteMeta,
  consoleState,
  error,
  firstAccessibleRoutePath,
  isAuthenticated,
  msg,
  sideNavCollapsed,
  currentUserScopes,
} = shell;
const { activeSideNavDirectory, showSideNavDirectory, sideNavWidth, sideNavDirectoryWidth } = sideNav;
const dashboardShellStyle = computed(() => ({
  "--sidebar-width": `${sideNavWidth.value}px`,
}));
const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
const shellMessages = computed(() => unref(msg));
const localizedErrorTitle = computed(() => localizeConsoleText(String(shellMessages.value?.error || ""), locale.value));
const localizedError = computed(() => localizeConsoleText(String(unref(error) || ""), locale.value));
const isLoginRoute = computed(() => route.path === "/login");
const isPublicRoute = computed(() => !!route.meta?.public);
const showPageDirectory = computed(() => isAuthenticated.value && !!activeSideNavDirectory.value && !isLoginRoute.value);
const canRenderPrivateRoute = computed(() => isAuthenticated.value && canAccessRouteMeta(route.meta));

function normalizeLoginRedirect(value: unknown) {
  const redirect = Array.isArray(value) ? value[0] : value;
  const path = typeof redirect === "string" ? redirect : "";
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/login")) {
    return "/";
  }
  return path;
}

watch(
  [routerReady, consoleBootstrapping, isAuthenticated, () => Boolean(consoleState.value), () => route.fullPath, () => currentUserScopes.value.join("\u0000"), () => activeConsoleFeatureIds.value.join("\u0000")],
  () => {
    if (!routerReady.value) {
      return;
    }
    if (consoleBootstrapping.value) {
      return;
    }
    if (!isAuthenticated.value && !isLoginRoute.value && !isPublicRoute.value) {
      void router.replace({
        path: "/welcome",
      });
      return;
    }
    if (isAuthenticated.value && isLoginRoute.value) {
      void router.replace(normalizeLoginRedirect(route.query.redirect));
      return;
    }
    if (isAuthenticated.value && !consoleState.value && !isPublicRoute.value) {
      return;
    }
    if (
      isAuthenticated.value &&
      !isLoginRoute.value &&
      !isPublicRoute.value &&
      !canAccessRouteMeta(route.meta)
    ) {
      void router.replace(firstAccessibleRoutePath());
    }
  },
  { immediate: true },
);
</script>

<template>
  <!-- Public landing page — no shell chrome -->
  <RouterView v-if="isPublicRoute" />

  <!-- Console shell -->
  <div
    v-else
    class="dashboard-shell"
    :class="{
      'is-locked': !isAuthenticated,
      'is-collapsed': isAuthenticated && sideNavCollapsed,
    }"
    :style="dashboardShellStyle"
  >
    <ConsoleSideNav />

    <main class="dashboard-canvas">
      <ConsoleTopbar />

      <div
        class="dashboard-main-region"
        :class="{
          'has-page-directory': showPageDirectory,
          'is-directory-collapsed': showPageDirectory && !showSideNavDirectory,
        }"
        :style="showPageDirectory ? { '--side-nav-directory-width': `${sideNavDirectoryWidth}px` } : undefined"
      >
        <ConsoleSideNavDirectory v-if="showPageDirectory" />

        <div class="view-content">
          <div v-if="error" class="status-strip danger">
            <strong>{{ localizedErrorTitle }}</strong>
            <span>{{ localizedError }}</span>
          </div>

          <RouterView v-if="isLoginRoute || canRenderPrivateRoute" v-slot="{ Component }">
            <Transition name="route-fade" mode="out-in">
              <component :is="Component" />
            </Transition>
          </RouterView>
        </div>
      </div>
    </main>

    <ConsoleDrawer />
    <ServerPathPickerDialog />
  </div>

  <ConsoleToastHost />
  <ConsoleConfirmDialog />
  <ConsoleCommandPalette />
</template>
