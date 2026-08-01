const WORKER_PROVIDERS: Readonly<Record<string, any>> = Object.freeze({
  "agent-worker": {
    specifier: "./agent-worker.ts",
    exportName: "createAgentWorkerRuntime"
  },
  "import-worker": {
    specifier: "./import-worker.ts",
    exportName: "createImportWorkerRuntime"
  },
  "maintenance-worker": {
    specifier: "./maintenance-worker.ts",
    exportName: "createMaintenanceWorkerRuntime"
  }
});

export async function createBackgroundWorkerRuntime({ role, userDataPath, ...options }: Record<string, any>) : Promise<any> {
  const provider: any = WORKER_PROVIDERS[role];
  if (!provider) {
    throw new Error(`Unknown background worker role: ${role}`);
  }
  const loaded: any = await import(provider.specifier);
  const factory: any = loaded[provider.exportName];
  if (typeof factory !== "function") {
    throw new Error(`Background worker ${role} is unavailable.`);
  }
  return factory({ ...options, role, userDataPath });
}
