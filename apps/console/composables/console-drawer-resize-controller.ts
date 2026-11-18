import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { readBrowserJsonStorage, writeBrowserJsonStorage } from "../lib/browser-storage";
import { browserWindow } from "@meshrix/ui-console/browser-window";
import { createConsolePointerDragController } from "./console-pointer-drag-controller";

const DRAWER_WIDTH_STORAGE_KEY: any = "v0.0.1:frontend:console-config-drawer-width-1";
const DEFAULT_DRAWER_WIDTH: any = 440;
const DEFAULT_VIEWPORT_WIDTH: any = 1280;
const MIN_DRAWER_WIDTH: any = 360;
const MAX_DRAWER_WIDTH: any = 920;
const VIEWPORT_MARGIN: any = 16;

function currentViewportWidth() : any {
  return browserWindow()?.innerWidth || DEFAULT_VIEWPORT_WIDTH;
}

function maxDrawerWidthForViewport(viewportWidth: number) : any {
  const safeViewportWidth: any = Number.isFinite(viewportWidth) ? viewportWidth : DEFAULT_VIEWPORT_WIDTH;
  return Math.max(280, Math.min(MAX_DRAWER_WIDTH, safeViewportWidth - VIEWPORT_MARGIN));
}

function clampDrawerWidth(width: number, viewportWidth: any = currentViewportWidth()) : any {
  const maxWidth: any = maxDrawerWidthForViewport(viewportWidth);
  const minWidth: any = Math.min(MIN_DRAWER_WIDTH, maxWidth);
  const safeWidth: any = Number.isFinite(width) ? width : DEFAULT_DRAWER_WIDTH;
  return Math.round(Math.max(minWidth, Math.min(safeWidth, maxWidth)));
}

function readStoredDrawerWidth() : any {
  return readBrowserJsonStorage<number>(
    DRAWER_WIDTH_STORAGE_KEY,
    DEFAULT_DRAWER_WIDTH,
    (value?: any) : any => {
      const numericValue: any = Number(value);
      return Number.isFinite(numericValue) ? numericValue : null;
    },
  );
}

function writeStoredDrawerWidth(width: number) : any {
  writeBrowserJsonStorage(DRAWER_WIDTH_STORAGE_KEY, clampDrawerWidth(width));
}

export function createConsoleDrawerResizeController() : any {
  const preferredDrawerWidth: any = ref(DEFAULT_DRAWER_WIDTH);
  const viewportWidth: any = ref(currentViewportWidth());
  const drawerWidth: any = computed(() : any => clampDrawerWidth(preferredDrawerWidth.value, viewportWidth.value));
  const drawerResizeStyle: any = computed<Record<string, string>>(() : any => ({
    "--config-drawer-width": `${drawerWidth.value}px`,
  }));
  const drawerResizeValueMin: any = computed(() : any =>
    Math.min(MIN_DRAWER_WIDTH, maxDrawerWidthForViewport(viewportWidth.value)),
  );
  const drawerResizeValueMax: any = computed(() : any =>
    maxDrawerWidthForViewport(viewportWidth.value),
  );

  function setDrawerWidth(width: number) : any {
    preferredDrawerWidth.value = clampDrawerWidth(width, viewportWidth.value);
  }

  function updateDrawerWidthFromClientX(clientX: number) : any {
    const browser: any = browserWindow();
    if (!browser) {
      return;
    }
    setDrawerWidth(browser.innerWidth - clientX);
  }

  const resizeDrag: any = createConsolePointerDragController({
    cursor: "col-resize",
    onMove: (event?: any) : any => updateDrawerWidthFromClientX(event.clientX),
    onStop: () : any => writeStoredDrawerWidth(drawerWidth.value),
  });

  function startDrawerResize(event: PointerEvent) : any {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    updateDrawerWidthFromClientX(event.clientX);
    resizeDrag.startPointerDrag(event);
  }

  function handleDrawerResizeKeydown(event: KeyboardEvent) : any {
    const step: any = event.shiftKey ? 40 : 16;
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

  function handleViewportResize() : any {
    viewportWidth.value = currentViewportWidth();
  }

  onMounted(() : any => {
    handleViewportResize();
    preferredDrawerWidth.value = readStoredDrawerWidth();
    browserWindow()?.addEventListener("resize", handleViewportResize);
  });

  onBeforeUnmount(() : any => {
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
