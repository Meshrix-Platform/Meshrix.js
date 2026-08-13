/**
 * Tag Store Adapter — Server-runtime implementation of the TagStoreProvider port.
 *
 * Adapts the runtime tag-management-store to conform to the foundation port
 * defined in `packages/foundation/src/security/authorization/tag-store.port.ts`.
 *
 * At composition time, `registerTagStoreProvider()` is called to wire this
 * adapter into the TagStoreProviderRegistry, so authorization modules in
 * foundation never directly import runtime/tag-state.
 *
 * @module tag-store-adapter
 * @package @meshrix/server-runtime
 * @layer server-runtime/state
 */

import { validateTagStoreProvider } from "#meshrix/foundation/security/authorization/tag-store.port";

/**
 * Creates a tag store adapter that wraps the runtime tag-management implementation
 * and conforms to the TagStoreProvider port contract.
 *
 * @param {object} options
 * @param {string} options.userDataPath - User data directory path
 * @returns {Promise<import("#meshrix/foundation/security/authorization/tag-store.port").TagStoreProvider>}
 */
export async function createTagStoreAdapter({ userDataPath }: Record<string, any>) : Promise<any> {
  const mod: any = await import("./tag-management-store.ts");
  const TagManagementStore: any = mod.TagManagementStore || mod.default;

  const store: any = TagManagementStore.createTagManagementStore(userDataPath);
  const validation: any = validateTagStoreProvider(store);

  if (!validation.valid) {
    throw new Error(
      `TagManagementStore does not conform to TagStoreProvider port. ` +
      `Missing methods: ${validation.missing.join(", ")}`
    );
  }

  return store;
}

/**
 * Registers the tag store provider into the given registry at composition time.
 *
 * @param {import("#meshrix/foundation/security/authorization/tag-store.port").TagStoreProviderRegistry} registry
 * @param {object} [options]
 * @param {string} [options.userDataPath] - Optional; provider set via adapter
 */
export async function registerTagStoreProvider(registry?: any, options: Record<string, any> = {}) : Promise<any> {
  if (!registry || typeof registry.setProvider !== "function") {
    throw new Error("registerTagStoreProvider: registry must have setProvider method");
  }

  if (options.userDataPath) {
    const adapter: any = await createTagStoreAdapter({ userDataPath: options.userDataPath });
    registry.setProvider(adapter);
  }
  // If no userDataPath is provided, the registry will contain no provider
  // and authorization operations will fail-closed — which is the correct
  // behavior in minimal/bootstrap profiles.
}
