import { computed, inject, onBeforeUnmount, provide, ref, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ServerConsoleShellContext } from "./serverConsoleShellContext";
import type { AppView } from "../types/app";

const consoleSideNavContextKeys = [
  "activeRouteAdminView",
  "activeRouteView",
  "appearancePresetId",
  "appearanceCycleScheme",
  "appearanceCycleSchemeLabel",
  "appearancePresetLabel",
  "approvalFlowConsole",
  "canAccessAdminView",
  "canAccessView",
  "consoleState",
  "cycleAppearancePreset",
  "hasAnyFeature",
  "hasFeature",
  "isAuthenticated",
  "languageMode",
  "msg",
  "openAdmin",
  "openDrawer",
  "sideNavCollapsed",
  "sideNavOpen",
  "switchView",
  "toggleLanguage",
  "toggleAppearanceCycleScheme",
  "tt",
  "workspacesConsole",
] as const;

type ConsoleSideNavContextKey = (typeof consoleSideNavContextKeys)[number];

type SideNavDirectoryView = "approval" | "workspaces";

const sideNavDirectoryViews = new Set<AppView>(["approval", "workspaces"]);

function isSideNavDirectoryView(view: unknown): view is SideNavDirectoryView {
  return sideNavDirectoryViews.has(view as AppView);
}

export type ConsoleSideNavContext = Pick<ServerConsoleShellContext, ConsoleSideNavContextKey> & {
  activeSideNavDirectory: ComputedRef<SideNavDirectoryView | "">;
  openSideNavDirectory: (view: AppView) => void;
  returnToPrimarySideNav: () => void;
  setSideNavWidth: (width: number) => void;
  setSideNavDirectoryWidth: (width: number) => void;
  showSideNavDirectory: ComputedRef<boolean>;
  sideNavMinWidth: number;
  sideNavDirectoryMinWidth: number;
  sideNavWidth: Ref<number>;
  sideNavDirectoryWidth: Ref<number>;
};

const SIDE_NAV_MIN_WIDTH = 200;
const SIDE_NAV_DEFAULT_WIDTH = 220;
const SIDE_NAV_WIDTH_STORAGE_KEY = "lico:console:sideNavWidth";
const SIDE_NAV_DIRECTORY_MIN_WIDTH = 220;
const SIDE_NAV_DIRECTORY_DEFAULT_WIDTH = SIDE_NAV_DIRECTORY_MIN_WIDTH;
const SIDE_NAV_DIRECTORY_NARROW_QUERY = "(max-width: 720px)";
const SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY = "lico:console:sideNavDirectoryWidth";
const SIDE_NAV_OVERLAY_BREAKPOINT = 860;
const SIDE_NAV_COLLAPSED_WIDTH = 56;
const MAIN_CONTENT_MIN_WIDTH = 480;
const DEFAULT_VIEWPORT_WIDTH = 1280;

function currentViewportWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_VIEWPORT_WIDTH;
  }
  const width = Number(window.innerWidth);
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_VIEWPORT_WIDTH;
}

function readStoredWidth(storageKey: string, fallback: number) {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null || stored.trim() === "") {
      return fallback;
    }
    const width = Number(stored);
    return Number.isFinite(width) ? width : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Storage can be unavailable in restricted browser contexts. The in-memory width remains usable.
  }
}

function clampWidth(width: number, minWidth: number, maxWidth: number, fallback: number) {
  const safeWidth = Number.isFinite(width) ? width : fallback;
  const safeMaxWidth = Math.max(minWidth, Math.floor(maxWidth));
  return Math.round(Math.max(minWidth, Math.min(safeWidth, safeMaxWidth)));
}

function readInitialSideNavWidth() {
  return readStoredWidth(SIDE_NAV_WIDTH_STORAGE_KEY, SIDE_NAV_DEFAULT_WIDTH);
}

function readInitialSideNavDirectoryWidth() {
  return readStoredWidth(SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY, SIDE_NAV_DIRECTORY_DEFAULT_WIDTH);
}

function isNarrowSideNavDirectoryViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDE_NAV_DIRECTORY_NARROW_QUERY).matches
  );
}

export function createConsoleSideNavContext(shell: ServerConsoleShellContext): ConsoleSideNavContext {
  const sideNavDirectoryOpen = ref(false);
  const sideNavDirectoryNarrow = ref(isNarrowSideNavDirectoryViewport());
  const viewportWidth = ref(currentViewportWidth());
  const sideNavWidth = ref(readInitialSideNavWidth());
  const sideNavDirectoryWidth = ref(readInitialSideNavDirectoryWidth());
  const activeSideNavDirectory = computed<SideNavDirectoryView | "">(() => {
    const view = shell.activeRouteView.value;
    return isSideNavDirectoryView(view) ? view : "";
  });
  const showSideNavDirectory = computed(() => !!activeSideNavDirectory.value && sideNavDirectoryOpen.value);

  function sideNavLayoutWidth() {
    if (viewportWidth.value <= SIDE_NAV_OVERLAY_BREAKPOINT) {
      return 0;
    }
    return shell.sideNavCollapsed.value ? SIDE_NAV_COLLAPSED_WIDTH : sideNavWidth.value;
  }

  function maxSideNavWidth(directoryWidth = showSideNavDirectory.value ? sideNavDirectoryWidth.value : 0) {
    if (viewportWidth.value <= SIDE_NAV_OVERLAY_BREAKPOINT) {
      return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH;
    }
    const reservedDirectoryWidth = showSideNavDirectory.value ? directoryWidth : 0;
    return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH - reservedDirectoryWidth;
  }

  function maxSideNavDirectoryWidth() {
    return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH - sideNavLayoutWidth();
  }

  function clampSideNavWidth(width: number, directoryWidth?: number) {
    return clampWidth(
      width,
      SIDE_NAV_MIN_WIDTH,
      maxSideNavWidth(directoryWidth),
      SIDE_NAV_DEFAULT_WIDTH,
    );
  }

  function clampSideNavDirectoryWidth(width: number) {
    return clampWidth(
      width,
      SIDE_NAV_DIRECTORY_MIN_WIDTH,
      maxSideNavDirectoryWidth(),
      SIDE_NAV_DIRECTORY_DEFAULT_WIDTH,
    );
  }

  function reconcileWidths() {
    const reservedDirectoryWidth = showSideNavDirectory.value ? SIDE_NAV_DIRECTORY_MIN_WIDTH : 0;
    sideNavWidth.value = clampSideNavWidth(sideNavWidth.value, reservedDirectoryWidth);
    sideNavDirectoryWidth.value = clampSideNavDirectoryWidth(sideNavDirectoryWidth.value);
  }

  function syncSideNavDirectoryFromRoute(view: unknown) {
    const shouldOpen = isSideNavDirectoryView(view) && !sideNavDirectoryNarrow.value;
    sideNavDirectoryOpen.value = shouldOpen;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mediaQuery = window.matchMedia(SIDE_NAV_DIRECTORY_NARROW_QUERY);
    const handleMediaQueryChange = () => {
      sideNavDirectoryNarrow.value = mediaQuery.matches;
    };

    handleMediaQueryChange();
    mediaQuery.addEventListener("change", handleMediaQueryChange);
    onBeforeUnmount(() => {
      mediaQuery.removeEventListener("change", handleMediaQueryChange);
    });
  }

  watch(
    [shell.activeRouteView, sideNavDirectoryNarrow],
    ([view]) => syncSideNavDirectoryFromRoute(view),
    { immediate: true },
  );

  watch(
    [showSideNavDirectory, shell.sideNavCollapsed],
    reconcileWidths,
    { immediate: true },
  );

  if (typeof window !== "undefined") {
    const handleViewportResize = () => {
      viewportWidth.value = currentViewportWidth();
      reconcileWidths();
    };
    window.addEventListener("resize", handleViewportResize);
    onBeforeUnmount(() => {
      window.removeEventListener("resize", handleViewportResize);
    });
  }

  function openSideNavDirectory(view: AppView) {
    const isDirectoryView = isSideNavDirectoryView(view);
    sideNavDirectoryOpen.value = isDirectoryView;
  }

  function returnToPrimarySideNav() {
    sideNavDirectoryOpen.value = false;
  }

  function setSideNavWidth(width: number) {
    const nextWidth = clampSideNavWidth(width);
    sideNavWidth.value = nextWidth;
    writeStoredWidth(SIDE_NAV_WIDTH_STORAGE_KEY, nextWidth);
  }

  function setSideNavDirectoryWidth(width: number) {
    const nextWidth = clampSideNavDirectoryWidth(width);
    sideNavDirectoryWidth.value = nextWidth;
    writeStoredWidth(SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY, nextWidth);
  }

  return {
    ...Object.fromEntries(consoleSideNavContextKeys.map((key) => [key, shell[key]])) as Pick<
      ServerConsoleShellContext,
      ConsoleSideNavContextKey
    >,
    activeSideNavDirectory,
    openSideNavDirectory,
    returnToPrimarySideNav,
    setSideNavWidth,
    setSideNavDirectoryWidth,
    showSideNavDirectory,
    sideNavMinWidth: SIDE_NAV_MIN_WIDTH,
    sideNavDirectoryMinWidth: SIDE_NAV_DIRECTORY_MIN_WIDTH,
    sideNavWidth,
    sideNavDirectoryWidth,
  };
}

const consoleSideNavKey = Symbol("console-side-nav") as InjectionKey<ConsoleSideNavContext>;

export function provideConsoleSideNavContext(context: ConsoleSideNavContext) {
  provide(consoleSideNavKey, context);
}

export function useConsoleSideNavContext() {
  const context = inject(consoleSideNavKey);
  if (!context) {
    throw new Error("Console side nav context is not available");
  }
  return context;
}
