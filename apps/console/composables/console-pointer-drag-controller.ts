import { ref } from "vue";

type PointerDragControllerOptions = {
  cursor?: string;
  onMove: (event: PointerEvent) => void;
  onStop?: () => void;
};

export function createConsolePointerDragController(options: PointerDragControllerOptions) {
  const dragging = ref(false);
  let dragDocument: Document | null = null;
  let previousBodyCursor = "";
  let previousBodyUserSelect = "";

  function clearBodyDragStyle() {
    if (!dragDocument?.body) {
      return;
    }
    dragDocument.body.style.cursor = previousBodyCursor;
    dragDocument.body.style.userSelect = previousBodyUserSelect;
  }

  function applyBodyDragStyle(nextDocument: Document) {
    if (!nextDocument.body) {
      return;
    }
    previousBodyCursor = nextDocument.body.style.cursor;
    previousBodyUserSelect = nextDocument.body.style.userSelect;
    nextDocument.body.style.cursor = options.cursor || "";
    nextDocument.body.style.userSelect = "none";
  }

  function removeDocumentListeners() {
    if (!dragDocument) {
      return;
    }
    dragDocument.removeEventListener("pointermove", handlePointerMove);
    dragDocument.removeEventListener("pointerup", stopPointerDrag);
    dragDocument.removeEventListener("pointercancel", stopPointerDrag);
  }

  function stopPointerDrag() {
    if (!dragging.value) {
      return;
    }
    removeDocumentListeners();
    clearBodyDragStyle();
    dragDocument = null;
    dragging.value = false;
    options.onStop?.();
  }

  function handlePointerMove(event: PointerEvent) {
    if (!dragging.value) {
      return;
    }
    options.onMove(event);
  }

  function documentForEvent(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement | null;
    return target?.ownerDocument || (typeof document !== "undefined" ? document : null);
  }

  function startPointerDrag(event: PointerEvent) {
    stopPointerDrag();
    const nextDocument = documentForEvent(event);
    if (!nextDocument) {
      return;
    }
    dragDocument = nextDocument;
    dragging.value = true;
    applyBodyDragStyle(nextDocument);
    nextDocument.addEventListener("pointermove", handlePointerMove);
    nextDocument.addEventListener("pointerup", stopPointerDrag);
    nextDocument.addEventListener("pointercancel", stopPointerDrag);
  }

  return {
    dragging,
    handlePointerMove,
    startPointerDrag,
    stopPointerDrag,
  };
}
