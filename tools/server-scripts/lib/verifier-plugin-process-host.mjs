export function createVerifierPluginProcessHost() {
  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    loadModule({ moduleUrl }) {
      return import(moduleUrl);
    },
    async close() {}
  });
}
