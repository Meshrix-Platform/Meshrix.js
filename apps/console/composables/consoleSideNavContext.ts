import { computed, inject, onBeforeUnmount, provide, ref, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";
import type { ServerConsoleShellContext } from "./useServerConsoleShell";
import type { AppView } from "../types/app";

const consoleSideNavContextKeys = [
  ["navigation", "activeRouteAdminView"],
  ["navigation", "activeRouteView"],
  ["preferences", "appearancePresetId"],
  ["preferences", "appearanceCycleScheme"],
  ["preferences", "appearanceCycleSchemeLabel"],
  ["preferences", "appearancePresetLabel"],
  ["approvals", "approvalFlowConsole"],
  ["access", "canAccessAdminView"],
  ["access", "canAccessView"],
  ["runtime", "consoleState"],
  ["preferences", "cycleAppearancePreset"],
  ["runtime", "hasAnyFeature"],
  ["runtime", "hasFeature"],
  ["access", "isAuthenticated"],
  ["preferences", "languageMode"],
  ["preferences", "msg"],
  ["navigation", "openAdmin"],
  ["overlays", "openDrawer"],
  ["navigation", "sideNavCollapsed"],
  ["navigation", "sideNavOpen"],
  ["navigation", "switchView"],
  ["preferences", "toggleLanguage"],
  ["preferences", "toggleAppearanceCycleScheme"],
  ["preferences", "tt"],
  ["workspaces", "workspacesConsole"],
] as const;

type ConsoleSideNavContextKey = (typeof consoleSideNavContextKeys)[number][1];
type ConsoleSideNavNamespace = (typeof consoleSideNavContextKeys)[number][0];

type SideNavDirectoryView = "approval" | "workspaces";

const sideNavDirectoryViews: any = new Set<AppView>(["approval", "workspaces"]);

function isSideNavDirectoryView(view: unknown): view is SideNavDirectoryView {
  return sideNavDirectoryViews.has(view as AppView);
}

export type ConsoleSideNavContext = {
  readonly [Key in ConsoleSideNavContextKey]: any;
} & {
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

const SIDE_NAV_MIN_WIDTH: any = 200;
const SIDE_NAV_DEFAULT_WIDTH: any = 220;
const SIDE_NAV_WIDTH_STORAGE_KEY: any = "meshrix:console:sideNavWidth";
const SIDE_NAV_DIRECTORY_MIN_WIDTH: any = 220;
const SIDE_NAV_DIRECTORY_DEFAULT_WIDTH: any = SIDE_NAV_DIRECTORY_MIN_WIDTH;
const SIDE_NAV_DIRECTORY_NARROW_QUERY: any = "(max-width: 720px)";
const SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY: any = "meshrix:console:sideNavDirectoryWidth";
const SIDE_NAV_OVERLAY_BREAKPOINT: any = 860;
const SIDE_NAV_COLLAPSED_WIDTH: any = 56;
const MAIN_CONTENT_MIN_WIDTH: any = 480;
const DEFAULT_VIEWPORT_WIDTH: any = 1280;

function currentViewportWidth() : any {
  if (typeof window === "undefined") {
    return DEFAULT_VIEWPORT_WIDTH;
  }
  const width: any = Number(window.innerWidth);
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_VIEWPORT_WIDTH;
}

function readStoredWidth(storageKey: string, fallback: number) : any {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const stored: any = window.localStorage.getItem(storageKey);
    if (stored === null || stored.trim() === "") {
      return fallback;
    }
    const width: any = Number(stored);
    return Number.isFinite(width) ? width : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredWidth(storageKey: string, width: number) : any {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Storage can be unavailable in restricted browser contexts. The in-memory width remains usable.
  }
}

function clampWidth(width: number, minWidth: number, maxWidth: number, fallback: number) : any {
  const safeWidth: any = Number.isFinite(width) ? width : fallback;
  const safeMaxWidth: any = Math.max(minWidth, Math.floor(maxWidth));
  return Math.round(Math.max(minWidth, Math.min(safeWidth, safeMaxWidth)));
}

function readInitialSideNavWidth() : any {
  return readStoredWidth(SIDE_NAV_WIDTH_STORAGE_KEY, SIDE_NAV_DEFAULT_WIDTH);
}

function readInitialSideNavDirectoryWidth() : any {
  return readStoredWidth(SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY, SIDE_NAV_DIRECTORY_DEFAULT_WIDTH);
}

function isNarrowSideNavDirectoryViewport() : any {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDE_NAV_DIRECTORY_NARROW_QUERY).matches
  );
}

export function createConsoleSideNavContext(shell: ServerConsoleShellContext): ConsoleSideNavContext {
  const sideNavDirectoryOpen: any = ref(false);
  const sideNavDirectoryNarrow: any = ref(isNarrowSideNavDirectoryViewport());
  const viewportWidth: any = ref(currentViewportWidth());
  const sideNavWidth: any = ref(readInitialSideNavWidth());
  const sideNavDirectoryWidth: any = ref(readInitialSideNavDirectoryWidth());
  const activeSideNavDirectory: any = computed<SideNavDirectoryView | "">(() : any => {
    const view: any = shell.navigation.activeRouteView.value;
    return isSideNavDirectoryView(view) ? view : "";
  });
  const showSideNavDirectory: any = computed(() : any => !!activeSideNavDirectory.value && sideNavDirectoryOpen.value);

  function sideNavLayoutWidth() : any {
    if (viewportWidth.value <= SIDE_NAV_OVERLAY_BREAKPOINT) {
      return 0;
    }
    return shell.navigation.sideNavCollapsed.value ? SIDE_NAV_COLLAPSED_WIDTH : sideNavWidth.value;
  }

  function maxSideNavWidth(directoryWidth: any = showSideNavDirectory.value ? sideNavDirectoryWidth.value : 0) : any {
    if (viewportWidth.value <= SIDE_NAV_OVERLAY_BREAKPOINT) {
      return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH;
    }
    const reservedDirectoryWidth: any = showSideNavDirectory.value ? directoryWidth : 0;
    return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH - reservedDirectoryWidth;
  }

  function maxSideNavDirectoryWidth() : any {
    return viewportWidth.value - MAIN_CONTENT_MIN_WIDTH - sideNavLayoutWidth();
  }

  function clampSideNavWidth(width: number, directoryWidth?: number) : any {
    return clampWidth(
      width,
      SIDE_NAV_MIN_WIDTH,
      maxSideNavWidth(directoryWidth),
      SIDE_NAV_DEFAULT_WIDTH,
    );
  }

  function clampSideNavDirectoryWidth(width: number) : any {
    return clampWidth(
      width,
      SIDE_NAV_DIRECTORY_MIN_WIDTH,
      maxSideNavDirectoryWidth(),
      SIDE_NAV_DIRECTORY_DEFAULT_WIDTH,
    );
  }

  function reconcileWidths() : any {
    const reservedDirectoryWidth: any = showSideNavDirectory.value ? SIDE_NAV_DIRECTORY_MIN_WIDTH : 0;
    sideNavWidth.value = clampSideNavWidth(sideNavWidth.value, reservedDirectoryWidth);
    sideNavDirectoryWidth.value = clampSideNavDirectoryWidth(sideNavDirectoryWidth.value);
  }

  function syncSideNavDirectoryFromRoute(view: unknown) : any {
    const shouldOpen: any = isSideNavDirectoryView(view) && !sideNavDirectoryNarrow.value;
    sideNavDirectoryOpen.value = shouldOpen;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mediaQuery: any = window.matchMedia(SIDE_NAV_DIRECTORY_NARROW_QUERY);
    const handleMediaQueryChange: any = () : any => {
      sideNavDirectoryNarrow.value = mediaQuery.matches;
    };

    handleMediaQueryChange();
    mediaQuery.addEventListener("change", handleMediaQueryChange);
    onBeforeUnmount(() : any => {
      mediaQuery.removeEventListener("change", handleMediaQueryChange);
    });
  }

  watch(
    [shell.navigation.activeRouteView, sideNavDirectoryNarrow],
    ([view]: any[]) : any => syncSideNavDirectoryFromRoute(view),
    { immediate: true },
  );

  watch(
    [showSideNavDirectory, shell.navigation.sideNavCollapsed],
    reconcileWidths,
    { immediate: true },
  );

  if (typeof window !== "undefined") {
    const handleViewportResize: any = () : any => {
      viewportWidth.value = currentViewportWidth();
      reconcileWidths();
    };
    window.addEventListener("resize", handleViewportResize);
    onBeforeUnmount(() : any => {
      window.removeEventListener("resize", handleViewportResize);
    });
  }

  function openSideNavDirectory(view: AppView) : any {
    const isDirectoryView: any = isSideNavDirectoryView(view);
    sideNavDirectoryOpen.value = isDirectoryView;
  }

  function returnToPrimarySideNav() : any {
    sideNavDirectoryOpen.value = false;
  }

  function setSideNavWidth(width: number) : any {
    const nextWidth: any = clampSideNavWidth(width);
    sideNavWidth.value = nextWidth;
    writeStoredWidth(SIDE_NAV_WIDTH_STORAGE_KEY, nextWidth);
  }

  function setSideNavDirectoryWidth(width: number) : any {
    const nextWidth: any = clampSideNavDirectoryWidth(width);
    sideNavDirectoryWidth.value = nextWidth;
    writeStoredWidth(SIDE_NAV_DIRECTORY_WIDTH_STORAGE_KEY, nextWidth);
  }

  const shellMembers: Record<string, any> = {};
  for (const [namespace, key] of consoleSideNavContextKeys) {
    const namespaceMembers: any = shell[namespace];
    shellMembers[key] = namespaceMembers?.[key];
  }
  return {
    ...shellMembers,
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
  } as ConsoleSideNavContext;
}

const consoleSideNavKey: any = Symbol("console-side-nav") as InjectionKey<ConsoleSideNavContext>;

export function provideConsoleSideNavContext(context: ConsoleSideNavContext) : any {
  provide(consoleSideNavKey, context);
}

export function useConsoleSideNavContext() : any {
  const context: any = inject(consoleSideNavKey);
  if (!context) {
    throw new Error("Console side nav context is not available");
  }
  return context;
}
