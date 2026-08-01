import { computed, reactive } from "vue";

export type ConsoleConfirmTone = "neutral" | "danger";

export type ConsoleConfirmRequest = {
  title?: string;
  message: string;
  tone?: ConsoleConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 高危操作可选的输入确认：用户必须输入与该值完全一致的文本才能确认。 */
  requireText?: string;
};

export type ConsoleConfirmAction = (
  message: string,
  options?: Omit<ConsoleConfirmRequest, "message"> & { defaultValue?: boolean },
) => Promise<boolean>;

type PendingConsoleConfirm = ConsoleConfirmRequest & {
  id: number;
  resolve: (confirmed: boolean) => void;
};

const state: any = reactive({
  queue: [] as PendingConsoleConfirm[],
  hostCount: 0,
});

let nextConfirmId: any = 1;

export function hasConsoleConfirmHost() : any {
  return state.hostCount > 0;
}

export function registerConsoleConfirmHost() : any {
  state.hostCount += 1;
}

export function unregisterConsoleConfirmHost() : any {
  state.hostCount = Math.max(0, state.hostCount - 1);
  if (!state.hostCount) {
    settleAllConsoleConfirms(false);
  }
}

export function requestConsoleConfirm(request: ConsoleConfirmRequest): Promise<boolean> {
  const message: any = String(request.message ?? "").trim();
  if (!message || !hasConsoleConfirmHost()) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve?: any) : any => {
    state.queue.push({ ...request, message, id: nextConfirmId, resolve });
    nextConfirmId += 1;
  });
}

export function settleConsoleConfirm(confirmed: boolean, expectedId?: number) : any {
  if (expectedId !== undefined && state.queue[0]?.id !== expectedId) {
    return false;
  }
  const current: any = state.queue.shift();
  current?.resolve(confirmed);
  return Boolean(current);
}

export function settleAllConsoleConfirms(confirmed: boolean) : any {
  while (state.queue.length) {
    settleConsoleConfirm(confirmed);
  }
}

export function useConsoleConfirmState() : any {
  return {
    currentConfirm: computed(() : any => state.queue[0] ?? null),
    settleConsoleConfirm,
  };
}
