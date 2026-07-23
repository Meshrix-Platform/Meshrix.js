/**
 * Domain Loader Registration
 *
 * Wires platform providers into runtime registries at composition startup.
 *
 * @module register-domain-loaders
 * @package @lico/server-runtime
 * @layer server-runtime/composition
 */

/**
 * Registers domain loaders into the provided registries.
 *
 * @param {object} options
 * @param {import("#lico/foundation/security/authorization/tag-store.port.mjs").TagStoreProviderRegistry} [options.tagStoreProviderRegistry]
 * @param {boolean} [options.enableTagStore=true]
 */
export async function registerDomainLoaders({
  tagStoreProviderRegistry,
  enableTagStore = true
}) {
  if (enableTagStore && tagStoreProviderRegistry) {
    const { registerTagStoreProvider } = await import(
      "#lico/server-runtime/state/tag-store-adapter"
    );
    registerTagStoreProvider(tagStoreProviderRegistry);
  }
}
