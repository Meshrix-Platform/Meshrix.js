import {
  provideWorkspacesView as providePublicWorkspacesView,
  useWorkspacesViewContext as usePublicWorkspacesViewContext,
} from "@meshrix/ui-console/workspaces-view-context";
import type { useWorkspacesConsole } from "./useWorkspacesConsole";

export type WorkspacesViewContext = ReturnType<typeof useWorkspacesConsole>;

export function provideWorkspacesView(context: WorkspacesViewContext) : any {
  providePublicWorkspacesView(context);
}

export function useWorkspacesViewContext() : any {
  return usePublicWorkspacesViewContext<WorkspacesViewContext>();
}
