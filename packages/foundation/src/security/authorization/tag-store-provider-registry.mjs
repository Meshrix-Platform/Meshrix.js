/**
 * Tag Store Provider Registry — Module-level singleton for tag store provider access.
 *
 * Wraps the `createTagStoreProviderRegistry()` factory from the port into a
 * module-level singleton so that authorization modules (like
 * authorization-governance-store) can import `getTagStoreProvider()` without
 * needing the registry passed through the call chain.
 *
 * ## Lifecycle
 *
 * 1. At composition time, `registerTagStoreProvider(provider)` is called once
 *    to set the runtime-provided implementation.
 * 2. Throughout the process lifetime, `getTagStoreProvider()` returns the same
 *    provider or null (fail-closed).
 * 3. Unregistered (never wired) => `getTagStoreProvider()` returns null
 *    — consumers that require tag authority MUST reject the operation.
 *
 * ## Usage
 *
 * ```js
 * import { getTagStoreProvider } from "./tag-store-provider-registry.mjs";
 * const provider = getTagStoreProvider();
 * if (provider) {
 *   provider.upsertAuthorizationRole(role, opts);
 * }
 * ```
 *
 * @module tag-store-provider-registry
 * @package @meshrix/foundation
 * @layer foundation/security
 */

import {
  createTagStoreProviderRegistry,
  TAG_STORE_PORT_VERSION
} from "./tag-store.port.mjs";

/**
 * @type {ReturnType<typeof createTagStoreProviderRegistry> | null}
 */
const registry = createTagStoreProviderRegistry();

/**
 * Registers a tag store provider at composition time.
 *
 * This is called once during server startup by the composition layer
 * (e.g., `register-security-providers.mjs`) to wire the runtime adapter
 * into the singleton registry.
 *
 * @param {import("./tag-store.port.mjs").TagStoreProvider} provider
 *   The tag store provider instance to register. Must conform to the
 *   TagStoreProvider interface.
 */
export function registerTagStoreProvider(provider) {
  registry.setProvider(provider);
}

/**
 * Returns the registered tag store provider, or null if none is registered.
 *
 * Authorization governance treats the null case as a fail-closed composition
 * error and exposes the registry diagnostic without falling back to local state.
 *
 * @returns {import("./tag-store.port.mjs").TagStoreProvider | null}
 */
export function getTagStoreProvider() {
  return registry.getProvider();
}

/**
 * Returns a diagnostic descriptor of the current registration state.
 *
 * @returns {import("./tag-store.port.mjs").TagStoreProviderDiagnostic}
 */
export function getTagStoreProviderDiagnostic() {
  return registry.getProviderDiagnostic();
}

/**
 * Checks whether a tag store provider has been registered.
 *
 * @returns {boolean}
 */
export function hasTagStoreProvider() {
  return registry.hasProvider();
}
