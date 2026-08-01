export function createVerifierPluginProcessHost() : any {
  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    loadModule({ moduleUrl }: Record<string, any>) : any {
      return import(moduleUrl);
    },
    async close() : Promise<any> {}
  });
}
