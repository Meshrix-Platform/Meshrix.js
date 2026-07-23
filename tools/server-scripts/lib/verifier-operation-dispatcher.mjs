import { MemoryLockManager } from "../../../packages/foundation/src/concurrency/lock-manager.mjs";
import { bindOperationDispatcher } from "../../../packages/server-runtime/src/composition/dispatch-operation.mjs";

export function createVerifierOperationDispatcher(concurrencyScope) {
  const normalizedScope = String(concurrencyScope || "").trim();
  if (!normalizedScope) {
    throw new TypeError("Verifier operation concurrency scope must be explicit.");
  }
  const lockManager = new MemoryLockManager();
  return Object.freeze({
    operationDispatcher: bindOperationDispatcher({
      lockManager,
      concurrencyScope: normalizedScope
    }),
    operationConcurrencyScope: normalizedScope,
    close: () => lockManager.destroy()
  });
}
