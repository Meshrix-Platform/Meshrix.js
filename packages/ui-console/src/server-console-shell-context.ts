import { inject, provide, type InjectionKey } from "vue";
const serverConsoleShellKey = Symbol("server-console-shell") as InjectionKey<object>;

export function provideServerConsoleShell<T extends object>(shell: T) {
  provide(serverConsoleShellKey, shell);
}

export function useServerConsoleShellContext<T extends object = Record<string, unknown>>() {
  const shell = inject(serverConsoleShellKey);
  if (!shell) {
    throw new Error("Server console shell context is not available");
  }
  return shell as T;
}

export function useOptionalServerConsoleShellContext<T extends object = Record<string, unknown>>() {
  return inject(serverConsoleShellKey, null) as T | null;
}
