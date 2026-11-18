import { onBeforeUnmount, onMounted } from "vue";
import { createConsoleWindowEventChannel } from "./console-window-event-channel";

export const PAGE_REFRESH_EVENT = "meshrix:page-refresh";

export type PageRefreshContext = {
  viewId: string;
  adminView: string;
  gatewayTab: string;
  debugTab: string;
  routePath: string;
};

export type PageRefreshTask = void | PromiseLike<unknown>;

export type PageRefreshEventDetail = PageRefreshContext & {
  addTask: (task: PageRefreshTask) => void;
};

const pageRefreshEventChannel = createConsoleWindowEventChannel<PageRefreshEventDetail>(PAGE_REFRESH_EVENT);

export function collectPageRefreshTasks(context: PageRefreshContext): Promise<unknown>[] {
  const tasks: Promise<unknown>[] = [];
  const detail: PageRefreshEventDetail = {
    ...context,
    addTask(task: PageRefreshTask): void {
      tasks.push(Promise.resolve(task));
    },
  };
  pageRefreshEventChannel.dispatch(detail);
  return tasks;
}

export function usePageRefreshHandler(
  predicate: (detail: PageRefreshEventDetail) => boolean,
  handler: (detail: PageRefreshEventDetail) => PageRefreshTask,
): void {
  let removeListener: (() => void) | null = null;
  const listener = (detail: PageRefreshEventDetail): void => {
    if (!detail || !predicate(detail)) {
      return;
    }
    detail.addTask(Promise.resolve().then(() : PageRefreshTask => handler(detail)));
  };

  onMounted(() => {
    removeListener = pageRefreshEventChannel.add(listener);
  });

  onBeforeUnmount(() => {
    removeListener?.();
    removeListener = null;
  });
}
