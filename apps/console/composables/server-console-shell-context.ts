import { inject, provide, type InjectionKey } from "vue";
import type { useServerConsoleShell } from "./useServerConsoleShell";

export type ServerConsoleShellContext = ReturnType<typeof useServerConsoleShell>;

export const serverConsoleShellKey: InjectionKey<ServerConsoleShellContext> =
  Symbol("server-console-shell");

export function provideServerConsoleShell(shell: ServerConsoleShellContext): void {
  provide(serverConsoleShellKey, shell);
}

export function useServerConsoleShellContext(): ServerConsoleShellContext {
  const shell = inject(serverConsoleShellKey);
  if (!shell) {
    throw new Error("Server console shell context is not available");
  }
  return shell;
}

export function useOptionalServerConsoleShellContext(): ServerConsoleShellContext | null {
  return inject(serverConsoleShellKey, null);
}
