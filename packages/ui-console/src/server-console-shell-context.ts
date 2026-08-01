import { inject, provide, type InjectionKey } from "vue";
const serverConsoleShellKey: any = Symbol("server-console-shell") as InjectionKey<object>;

export function provideServerConsoleShell<T extends object>(shell: T) : any {
  provide(serverConsoleShellKey, shell);
}

export function useServerConsoleShellContext<T extends object = Record<string, unknown>>() : any {
  const shell: any = inject(serverConsoleShellKey);
  if (!shell) {
    throw new Error("Server console shell context is not available");
  }
  return shell as T;
}

export function useOptionalServerConsoleShellContext<T extends object = Record<string, unknown>>() : any {
  return inject(serverConsoleShellKey, null) as T | null;
}
