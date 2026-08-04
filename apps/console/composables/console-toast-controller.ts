import { reactive } from "vue";

export type ConsoleToastTone = "info" | "success" | "danger";

export type ConsoleToastAction = {
  label: string;
  run: () => void;
};

export type ConsoleToast = {
  id: number;
  tone: ConsoleToastTone;
  title: string;
  message: string;
  action?: ConsoleToastAction;
};

export type ConsoleToastOptions = {
  tone?: ConsoleToastTone;
  title?: string;
  message: string;
  timeoutMs?: number;
  action?: ConsoleToastAction;
};

export const CONSOLE_TOAST_LIMIT: any = 5;

const DEFAULT_TIMEOUT_MS: Record<string, number> = {
  info: 4200,
  success: 3600,
  // Danger stays open by default: 0 means no auto-dismiss timer is scheduled.
  danger: 0,
};

const state: any = reactive({
  toasts: [] as ConsoleToast[],
});

let nextToastId: any = 1;
const dismissTimers: any = new Map<number, ReturnType<typeof setTimeout>>();

function clearDismissTimer(id: number) : any {
  const timer: any = dismissTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    dismissTimers.delete(id);
  }
}

export function dismissConsoleToast(id: number) : any {
  clearDismissTimer(id);
  const index: any = state.toasts.findIndex((toast?: any) : any => toast.id === id);
  if (index >= 0) {
    state.toasts.splice(index, 1);
  }
}

export function pushConsoleToast(options: ConsoleToastOptions): number {
  const title: any = String(options.title ?? "").trim();
  const message: any = String(options.message ?? "").trim();
  if (!title && !message) {
    return 0;
  }
  const tone: any = options.tone ?? "info";
  const id: any = nextToastId;
  nextToastId += 1;
  const action: ConsoleToastAction | undefined = options.action;
  state.toasts.push({ id, tone, title, message, ...(action ? { action } : {}) });
  while (state.toasts.length > CONSOLE_TOAST_LIMIT) {
    dismissConsoleToast(state.toasts[0].id);
  }
  const timeoutMs: any = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[tone];
  if (timeoutMs > 0) {
    dismissTimers.set(id, setTimeout(() : any => dismissConsoleToast(id), timeoutMs));
  }
  return id;
}

export function clearConsoleToasts() : any {
  for (const toast of [...state.toasts]) {
    dismissConsoleToast(toast.id);
  }
}

export function useConsoleToasts() : any {
  return {
    toasts: state.toasts,
    dismissConsoleToast,
  };
}
