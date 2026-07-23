import {
  provideServerConsoleShell as providePublicServerConsoleShell,
  useOptionalServerConsoleShellContext as useOptionalPublicServerConsoleShellContext,
  useServerConsoleShellContext as usePublicServerConsoleShellContext,
} from "@lico/ui-console/server-console-shell-context";
import type { useServerConsoleShell } from "./useServerConsoleShell";

export type ServerConsoleShellContext = ReturnType<typeof useServerConsoleShell>;

export function provideServerConsoleShell(shell: ServerConsoleShellContext) {
  providePublicServerConsoleShell(shell);
}

export function useServerConsoleShellContext() {
  return usePublicServerConsoleShellContext<ServerConsoleShellContext>();
}

export function useOptionalServerConsoleShellContext() {
  return useOptionalPublicServerConsoleShellContext<ServerConsoleShellContext>();
}
