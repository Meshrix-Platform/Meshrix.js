import { onBeforeUnmount, onMounted } from "vue";
import { createConsoleWindowEventChannel } from "./console-window-event-channel";

export const PAGE_REFRESH_EVENT: any = "meshrix:page-refresh";

export type PageRefreshContext = {
  viewId: string;
  adminView: string;
  gatewayTab: string;
  debugTab: string;
  routePath: string;
};

export type PageRefreshTask = Promise<unknown> | unknown;

export type PageRefreshEventDetail = PageRefreshContext & {
  addTask: (task: PageRefreshTask) => void;
};

const pageRefreshEventChannel: any = createConsoleWindowEventChannel<PageRefreshEventDetail>(PAGE_REFRESH_EVENT);

export function collectPageRefreshTasks(context: PageRefreshContext) : any {
  const tasks: Promise<unknown>[] = [];
  const detail: PageRefreshEventDetail = {
    ...context,
    addTask(task?: any) : any {
      tasks.push(Promise.resolve(task));
    },
  };
  pageRefreshEventChannel.dispatch(detail);
  return tasks;
}

export function usePageRefreshHandler(
  predicate: (detail: PageRefreshEventDetail) => boolean,
  handler: (detail: PageRefreshEventDetail) => PageRefreshTask,
) : any {
  let removeListener: (() => void) | null = null;
  const listener: any = (detail: PageRefreshEventDetail) : any => {
    if (!detail || !predicate(detail)) {
      return;
    }
    detail.addTask(Promise.resolve().then(() : PageRefreshTask => handler(detail)));
  };

  onMounted(() : any => {
    removeListener = pageRefreshEventChannel.add(listener);
  });

  onBeforeUnmount(() : any => {
    removeListener?.();
    removeListener = null;
  });
}
