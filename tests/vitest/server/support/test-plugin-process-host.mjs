/**
 * Unit-test adapter only. Production composition intentionally does not bind
 * this adapter; it exists so runtime contract tests can exercise plugins while
 * the production boundary proves that no implicit in-process fallback exists.
 */
export function createTestPluginProcessHost() {
  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    loadModule({ moduleUrl }) {
      return import(moduleUrl);
    },
    async close() {}
  });
}
