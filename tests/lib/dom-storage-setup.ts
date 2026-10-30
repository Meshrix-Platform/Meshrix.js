// Node's built-in localStorage/sessionStorage globals shadow the jsdom
// implementations and resolve to undefined without --localstorage-file.
// DOM-environment tests exercise the browser storage contract, so restore a
// deterministic in-memory Storage whenever the global is missing.
const testWindow: any = (globalThis as any).window;

function memoryStorage(): any {
  const entries = new Map<string, string>();
  return {
    get length(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
    getItem(key: string): string | null {
      const normalized = String(key);
      return entries.has(normalized) ? entries.get(normalized)! : null;
    },
    key(index: number): string | null {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      entries.delete(String(key));
    },
    setItem(key: string, value: string): void {
      entries.set(String(key), String(value));
    },
  };
}

if (testWindow != null) {
  for (const name of ["localStorage", "sessionStorage"]) {
    if (testWindow[name] != null) {
      continue;
    }
    const storage = memoryStorage();
    for (const target of new Set<any>([globalThis, testWindow])) {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: storage,
      });
    }
  }
}
