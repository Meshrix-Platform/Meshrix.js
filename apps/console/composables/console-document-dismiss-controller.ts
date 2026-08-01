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
) : any {
  function containsEventTarget(event: Event) : any {
    const root: any = options.root.value;
    const target: any = event.target;
    return Boolean(root && target instanceof Node && root.contains(target));
  }

  function handleDocumentPointerDown(event: PointerEvent) : any {
    if (!options.active.value || containsEventTarget(event)) {
      return;
    }
    options.onDismiss();
  }

  function handleDocumentKeydown(event: KeyboardEvent) : any {
    if (!options.active.value || event.key !== "Escape") {
      return;
    }
    options.onDismiss();
  }

  onMounted(() : any => {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeydown);
  });

  onBeforeUnmount(() : any => {
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    document.removeEventListener("keydown", handleDocumentKeydown);
  });

  return {
    handleDocumentKeydown,
    handleDocumentPointerDown,
  };
}
