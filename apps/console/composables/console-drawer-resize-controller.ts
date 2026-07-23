import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { readBrowserJsonStorage, writeBrowserJsonStorage } from "../lib/browser-storage";
import { browserWindow } from "../lib/browser-window";
import { createConsolePointerDragController } from "./console-pointer-drag-controller";

const DRAWER_WIDTH_STORAGE_KEY = "v0.0.1:frontend:console-config-drawer-width-1";
const DEFAULT_DRAWER_WIDTH = 440;
const DEFAULT_VIEWPORT_WIDTH = 1280;
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_WIDTH = 920;
const VIEWPORT_MARGIN = 16;

function currentViewportWidth() {
  return browserWindow()?.innerWidth || DEFAULT_VIEWPORT_WIDTH;
}

function maxDrawerWidthForViewport(viewportWidth: number) {
  const safeViewportWidth = Number.isFinite(viewportWidth) ? viewportWidth : DEFAULT_VIEWPORT_WIDTH;
  return Math.max(280, Math.min(MAX_DRAWER_WIDTH, safeViewportWidth - VIEWPORT_MARGIN));
}

function clampDrawerWidth(width: number, viewportWidth = currentViewportWidth()) {
  const maxWidth = maxDrawerWidthForViewport(viewportWidth);
  const minWidth = Math.min(MIN_DRAWER_WIDTH, maxWidth);
  const safeWidth = Number.isFinite(width) ? width : DEFAULT_DRAWER_WIDTH;
  return Math.round(Math.max(minWidth, Math.min(safeWidth, maxWidth)));
}

function readStoredDrawerWidth() {
  return readBrowserJsonStorage<number>(
    DRAWER_WIDTH_STORAGE_KEY,
    DEFAULT_DRAWER_WIDTH,
    (value) => {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) ? numericValue : null;
    },
  );
}

function writeStoredDrawerWidth(width: number) {
  writeBrowserJsonStorage(DRAWER_WIDTH_STORAGE_KEY, clampDrawerWidth(width));
}

export function createConsoleDrawerResizeController() {
  const preferredDrawerWidth = ref(DEFAULT_DRAWER_WIDTH);
  const viewportWidth = ref(currentViewportWidth());
  const drawerWidth = computed(() => clampDrawerWidth(preferredDrawerWidth.value, viewportWidth.value));
  const drawerResizeStyle = computed<Record<string, string>>(() => ({
    "--config-drawer-width": `${drawerWidth.value}px`,
  }));
  const drawerResizeValueMin = computed(() =>
    Math.min(MIN_DRAWER_WIDTH, maxDrawerWidthForViewport(viewportWidth.value)),
  );
  const drawerResizeValueMax = computed(() =>
    maxDrawerWidthForViewport(viewportWidth.value),
  );

  function setDrawerWidth(width: number) {
    preferredDrawerWidth.value = clampDrawerWidth(width, viewportWidth.value);
  }

  function updateDrawerWidthFromClientX(clientX: number) {
    const browser = browserWindow();
    if (!browser) {
      return;
    }
    setDrawerWidth(browser.innerWidth - clientX);
  }

  const resizeDrag = createConsolePointerDragController({
    cursor: "col-resize",
    onMove: (event) => updateDrawerWidthFromClientX(event.clientX),
    onStop: () => writeStoredDrawerWidth(drawerWidth.value),
  });

  function startDrawerResize(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    updateDrawerWidthFromClientX(event.clientX);
    resizeDrag.startPointerDrag(event);
  }

  function handleDrawerResizeKeydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDrawerWidth(drawerWidth.value + step);
      writeStoredDrawerWidth(drawerWidth.value);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDrawerWidth(drawerWidth.value - step);
      writeStoredDrawerWidth(drawerWidth.value);
    } else if (event.key === "Home") {
      event.preventDefault();
      setDrawerWidth(drawerResizeValueMin.value);
      writeStoredDrawerWidth(drawerWidth.value);
    } else if (event.key === "End") {
      event.preventDefault();
      setDrawerWidth(drawerResizeValueMax.value);
      writeStoredDrawerWidth(drawerWidth.value);
    }
  }

  function handleViewportResize() {
    viewportWidth.value = currentViewportWidth();
  }

  onMounted(() => {
    handleViewportResize();
    preferredDrawerWidth.value = readStoredDrawerWidth();
    browserWindow()?.addEventListener("resize", handleViewportResize);
  });

  onBeforeUnmount(() => {
    resizeDrag.stopPointerDrag();
    browserWindow()?.removeEventListener("resize", handleViewportResize);
  });

  return {
    drawerResizeDragging: resizeDrag.dragging,
    drawerResizeStyle,
    drawerResizeValueMax,
    drawerResizeValueMin,
    drawerWidth,
    handleDrawerResizeKeydown,
    startDrawerResize,
  };
}
