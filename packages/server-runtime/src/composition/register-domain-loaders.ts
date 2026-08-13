/**
 * Domain Loader Registration
 *
 * Wires platform providers into runtime registries at composition startup.
 *
 * @module register-domain-loaders
 * @package @meshrix/server-runtime
 * @layer server-runtime/composition
 */

/**
 * Registers domain loaders into the provided registries.
 *
 * @param {object} options
 * @param {import("#meshrix/foundation/security/authorization/tag-store.port").TagStoreProviderRegistry} [options.tagStoreProviderRegistry]
 * @param {boolean} [options.enableTagStore=true]
 */
export async function registerDomainLoaders({
  tagStoreProviderRegistry,
  enableTagStore = true
}: Record<string, any>) : Promise<any> {
  if (enableTagStore && tagStoreProviderRegistry) {
    const { registerTagStoreProvider } = await import(
      "#meshrix/server-runtime/state/tag-store-adapter"
    );
    registerTagStoreProvider(tagStoreProviderRegistry);
  }
}
