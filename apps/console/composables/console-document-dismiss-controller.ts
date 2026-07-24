import { onBeforeUnmount, onMounted, type Ref } from "vue";

type ReadonlyRef<T> = {
  readonly value: T;
};

type DocumentDismissControllerOptions = {
  active: ReadonlyRef<boolean>;
  root: Ref<HTMLElement | null>;
  onDismiss: () => void;
};

export function useConsoleDocumentDismissController(
  options: DocumentDismissControllerOptions,
) {
  function containsEventTarget(event: Event) {
    const root = options.root.value;
    const target = event.target;
    return Boolean(root && target instanceof Node && root.contains(target));
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!options.active.value || containsEventTarget(event)) {
      return;
    }
    options.onDismiss();
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (!options.active.value || event.key !== "Escape") {
      return;
    }
    options.onDismiss();
  }

  onMounted(() => {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  return {
    handleDocumentKeydown,
    handleDocumentPointerDown,
  };
}
