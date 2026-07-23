import { reactive } from "vue";

export type ConsoleToastTone = "info" | "success" | "danger";

export type ConsoleToast = {
  id: number;
  tone: ConsoleToastTone;
  title: string;
  message: string;
};

export type ConsoleToastOptions = {
  tone?: ConsoleToastTone;
  title?: string;
  message: string;
  timeoutMs?: number;
};

export const CONSOLE_TOAST_LIMIT = 5;

const DEFAULT_TIMEOUT_MS: Record<ConsoleToastTone, number> = {
  info: 4200,
  success: 3600,
  danger: 6500,
};

const state = reactive({
  toasts: [] as ConsoleToast[],
});

let nextToastId = 1;
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearDismissTimer(id: number) {
  const timer = dismissTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    dismissTimers.delete(id);
  }
}

export function dismissConsoleToast(id: number) {
  clearDismissTimer(id);
  const index = state.toasts.findIndex((toast) => toast.id === id);
  if (index >= 0) {
    state.toasts.splice(index, 1);
  }
}

export function pushConsoleToast(options: ConsoleToastOptions): number {
  const title = String(options.title ?? "").trim();
  const message = String(options.message ?? "").trim();
  if (!title && !message) {
    return 0;
  }
  const tone = options.tone ?? "info";
  const id = nextToastId;
  nextToastId += 1;
  state.toasts.push({ id, tone, title, message });
  while (state.toasts.length > CONSOLE_TOAST_LIMIT) {
    dismissConsoleToast(state.toasts[0].id);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[tone];
  if (timeoutMs > 0) {
    dismissTimers.set(id, setTimeout(() => dismissConsoleToast(id), timeoutMs));
  }
  return id;
}

export function clearConsoleToasts() {
  for (const toast of [...state.toasts]) {
    dismissConsoleToast(toast.id);
  }
}

export function useConsoleToasts() {
  return {
    toasts: state.toasts,
    dismissConsoleToast,
  };
}
