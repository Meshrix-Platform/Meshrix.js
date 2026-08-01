import {
  provideServerConsoleShell as providePublicServerConsoleShell,
  useOptionalServerConsoleShellContext as useOptionalPublicServerConsoleShellContext,
  useServerConsoleShellContext as usePublicServerConsoleShellContext,
} from "@meshrix/ui-console/server-console-shell-context";
import type { useServerConsoleShell } from "./useServerConsoleShell";

export type ServerConsoleShellContext = ReturnType<typeof useServerConsoleShell>;

export function provideServerConsoleShell(shell: ServerConsoleShellContext) : any {
  providePublicServerConsoleShell(shell);
}

export function useServerConsoleShellContext() : any {
  return usePublicServerConsoleShellContext<ServerConsoleShellContext>();
}

export function useOptionalServerConsoleShellContext() : any {
  return useOptionalPublicServerConsoleShellContext<ServerConsoleShellContext>();
}
