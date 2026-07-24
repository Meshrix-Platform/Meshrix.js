/**
 * Tag Store Adapter — Runtime implementation of the TagStoreProvider port.
 *
 * Wraps `createTagManagementStore` from the runtime tag management store
 * so it conforms to the TagStoreProvider port defined in foundation.
 *
 * This adapter is the ONLY server-runtime code that imports the concrete
 * tag management store.  Foundation-level authorization modules interact
 * solely through the TagStoreProvider port, never through runtime state.
 *
 * @module tag-store-adapter
 * @package @meshrix/server-runtime
 * @layer server-runtime/state/tags
 */

import { validateTagStoreProvider } from "../../../../foundation/src/security/authorization/tag-store.port.mjs";
import { createTagManagementStore } from "../tag-management-store.mjs";

/**
 * Creates a tag store provider that wraps the runtime tag management store
 * and conforms to the TagStoreProvider port contract.
 *
 * @param {object} options
 * @param {string} options.userDataPath - User data directory path for the SQLite database
 * @returns {import("#meshrix/foundation/security/authorization/tag-store.port.mjs").TagStoreProvider}
 */
export function createTagStoreAdapter({ userDataPath = "" } = {}) {
  if (!userDataPath) {
    throw new Error(
      "createTagStoreAdapter requires a userDataPath. " +
      "The tag management store cannot be initialised without a data directory."
    );
  }

  const store = createTagManagementStore({ userDataPath });
  const validation = validateTagStoreProvider(store);

  if (!validation.valid) {
    throw new Error(
      `Tag management store does not conform to the TagStoreProvider port. ` +
      `Missing methods: ${validation.missing.join(", ")}`
    );
  }

  return store;
}
