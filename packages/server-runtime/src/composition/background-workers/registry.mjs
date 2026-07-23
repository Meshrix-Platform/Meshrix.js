const WORKER_PROVIDERS = Object.freeze({
  "agent-worker": {
    specifier: "./agent-worker.mjs",
    exportName: "createAgentWorkerRuntime"
  },
  "import-worker": {
    specifier: "./import-worker.mjs",
    exportName: "createImportWorkerRuntime"
  },
  "maintenance-worker": {
    specifier: "./maintenance-worker.mjs",
    exportName: "createMaintenanceWorkerRuntime"
  }
});

export async function createBackgroundWorkerRuntime({ role, userDataPath, ...options }) {
  const provider = WORKER_PROVIDERS[role];
  if (!provider) {
    throw new Error(`Unknown background worker role: ${role}`);
  }
  const loaded = await import(provider.specifier);
  const factory = loaded[provider.exportName];
  if (typeof factory !== "function") {
    throw new Error(`Background worker ${role} is unavailable.`);
  }
  return factory({ ...options, role, userDataPath });
}
