import { nextTick, type Ref } from "vue";

// Shared overlay behavior extracted from ConsoleConfirmDialog (the conformant
// reference): Escape-to-close, a Tab focus trap, previous-focus capture, and
// focus restore. Concurrency model: ONE modal overlay at a time — the
// document keydown listener is registered on activate and removed on
// deactivate, so stacked modals are out of contract.
//
// Consumers watch their `open` ref, call activate()/deactivate() on
// transitions, and call deactivate() again in onBeforeUnmount (idempotent).

export type ConsoleOverlayInitialFocus = "first" | "cancel-safe";

export type ConsoleOverlayControllerOptions = {
  root: Ref<HTMLElement | null>;
  open: Ref<boolean>;
  invoker?: Ref<HTMLElement | null>;
  onClose: () => void;
  initialFocus?: ConsoleOverlayInitialFocus;
};

export type ConsoleOverlayController = {
  onKeydown: (event: KeyboardEvent) => void;
  activate: () => Promise<void>;
  deactivate: () => void;
};

// Ported verbatim from ConsoleConfirmDialog.vue: tabbable elements minus
// [disabled], minus [hidden].
const OVERLAY_FOCUSABLE_SELECTOR: string =
  "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function createConsoleOverlayController(
  options: ConsoleOverlayControllerOptions,
): ConsoleOverlayController {
  let previouslyFocusedElement: HTMLElement | null = null;
  let listening = false;

  function focusableElements(): HTMLElement[] {
    const container = options.root.value;
    if (!container) {
      return [];
    }
    return Array.from(container.querySelectorAll<HTMLElement>(OVERLAY_FOCUSABLE_SELECTOR))
      .filter((element: HTMLElement) => !element.hasAttribute("hidden"));
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!options.open.value) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      options.onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const container = options.root.value;
    if (!container) {
      // Missing root disables the trap: log in dev, never throw.
      console.warn("console-overlay-controller: root element is missing; focus trap disabled.");
      return;
    }

    const focusable = focusableElements();
    if (!focusable.length) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  async function activate(): Promise<void> {
    if (listening) {
      return;
    }
    listening = true;
    // Restore target: the explicit invoker wins; otherwise whatever had focus
    // just before the overlay opened — never document.body.
    const invoker = options.invoker?.value || null;
    const active = document.activeElement;
    previouslyFocusedElement =
      invoker || (active instanceof HTMLElement && active !== document.body ? active : null);
    document.addEventListener("keydown", onKeydown);
    await nextTick();

    const focusable = focusableElements();
    const container = options.root.value;
    let target: HTMLElement | null = null;
    if (options.initialFocus === "cancel-safe") {
      // The dismiss/close affordance marked by the consumer wins, so the safe
      // action is the default focus; falls back to the first focusable.
      target =
        container?.querySelector<HTMLElement>("[data-overlay-cancel-safe]:not([disabled])") ||
        focusable[0] ||
        null;
    } else {
      target = focusable[0] || null;
    }
    (target || container)?.focus({ preventScroll: true });
  }

  function deactivate(): void {
    if (listening) {
      document.removeEventListener("keydown", onKeydown);
      listening = false;
    }
    const restoreTarget = previouslyFocusedElement;
    previouslyFocusedElement = null;
    // The invoker may have unmounted while the overlay was open.
    if (restoreTarget?.isConnected) {
      restoreTarget.focus({ preventScroll: true });
    }
  }

  return {
    onKeydown,
    activate,
    deactivate,
  };
}
