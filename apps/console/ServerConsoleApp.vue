<script setup lang="ts">
import { computed, ref, unref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConsoleCommandPalette from "./components/shell/ConsoleCommandPalette.vue";
import ConsoleConfirmDialog from "./components/ConsoleConfirmDialog.vue";
import ConsoleSkeleton from "./components/ConsoleSkeleton.vue";
import ConsoleToastHost from "./components/ConsoleToastHost.vue";
import ConsoleDrawer from "./components/shell/ConsoleDrawer.vue";
import ConsoleSideNav from "./components/shell/ConsoleSideNav.vue";
import ConsoleSideNavDirectory from "./components/shell/side-nav/ConsoleSideNavDirectory.vue";
import ConsoleTopbar from "./components/shell/ConsoleTopbar.vue";
import ServerPathPickerDialog from "./components/shell/ServerPathPickerDialog.vue";
import { createConsoleSideNavContext, provideConsoleSideNavContext } from "./composables/consoleSideNavContext";
import { provideServerConsoleShell } from "#meshrix/console/server-console-shell-context";
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
  consoleState,
  error,
} = shell.runtime;
const {
  canAccessRouteMeta,
  isAuthenticated,
  currentUserScopes,
} = shell.access;
const {
  firstAccessibleRoutePath,
  sideNavCollapsed,
} = shell.navigation;
const { msg } = shell.preferences;
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
// Authenticated cold boot: the route view renders nothing until consoleState
// lands, so show a skeleton to keep loading distinguishable from broken.
const showColdBootSkeleton = computed(() => isAuthenticated.value && !isLoginRoute.value && !isPublicRoute.value && !canRenderPrivateRoute.value);

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

          <div v-if="showColdBootSkeleton" class="sk-block" role="status">
            <span class="visually-hidden">{{ shellMessages?.skeleton?.loading }}</span>
            <ConsoleSkeleton variant="title" />
            <ConsoleSkeleton variant="text" :lines="4" />
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
