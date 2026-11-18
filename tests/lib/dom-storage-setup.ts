// Node's built-in localStorage/sessionStorage globals shadow the jsdom
// implementations and resolve to undefined without --localstorage-file.
// DOM-environment tests exercise the browser storage contract, so restore a
// deterministic in-memory Storage whenever the global is missing or does not
// honour the DOM Storage contract (stored keys must be enumerable own keys).
const testWindow: any = (globalThis as any).window;

function memoryStorage(): any {
  const storage: Record<string, any> = {};
  Object.defineProperties(storage, {
    length: {
      enumerable: false,
      get(): number {
        return Object.keys(storage).length;
      },
    },
    clear: {
      enumerable: false,
      value(): void {
        for (const key of Object.keys(storage)) {
          delete storage[key];
        }
      },
    },
    getItem: {
      enumerable: false,
      value(key: string): string | null {
        const normalized = String(key);
        return normalized in storage ? storage[normalized] : null;
      },
    },
    key: {
      enumerable: false,
      value(index: number): string | null {
        return Object.keys(storage)[index] ?? null;
      },
    },
    removeItem: {
      enumerable: false,
      value(key: string): void {
        delete storage[String(key)];
      },
    },
    setItem: {
      enumerable: false,
      value(key: string, value: string): void {
        storage[String(key)] = String(value);
      },
    },
  });
  return storage;
}

function conformsToDomStorage(storage: any): boolean {
  try {
    const probe = "meshrix.storage.probe";
    storage.setItem(probe, "1");
    const conforms =
      storage.getItem(probe) === "1" && Object.keys(storage).includes(probe);
    storage.removeItem(probe);
    return conforms;
  } catch {
    return false;
  }
}

if (testWindow != null) {
  for (const name of ["localStorage", "sessionStorage"]) {
    if (testWindow[name] != null && conformsToDomStorage(testWindow[name])) {
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
