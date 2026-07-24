/**
 * Security Provider Registration — Composition-time wiring of security providers.
 *
 * Registers the tag store adapter into the singleton TagStoreProviderRegistry
 * so that foundation-level authorization modules can access tag management
 * without layer-violating imports.
 *
 * This is called during server startup from the composition root, after all
 * infrastructure is initialized but before API handlers begin serving requests.
 *
 * @module register-security-providers
 * @package @meshrix/server-runtime
 * @layer server-runtime/composition
 */

/**
 * Registers the tag store provider into the singleton registry.
 *
 * @param {object} options
 * @param {string} options.userDataPath - User data directory path
 */
export async function registerSecurityProviders({ userDataPath }) {
  const { registerTagStoreProvider: registerSingletonProvider } = await import(
    "#meshrix/foundation/security/authorization/tag-store-provider-registry"
  );
  const { createTagStoreAdapter } = await import(
    "../state/tags/tag-store.adapter.mjs"
  );

  if (!userDataPath) {
    return null;
  }

  const adapter = createTagStoreAdapter({ userDataPath });
  registerSingletonProvider(adapter);
  return adapter;
}
