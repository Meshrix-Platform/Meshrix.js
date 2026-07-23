import { dispatchOperation } from "./dispatch-operation-core.mjs";

export function bindOperationDispatcher({ lockManager, concurrencyScope = "default" } = {}) {
  if (!lockManager || typeof lockManager.acquire !== "function") {
    throw new TypeError("Bound operation dispatcher requires a LockManager.");
  }
  const boundConcurrencyScope = String(concurrencyScope || "").trim();
  if (!boundConcurrencyScope) {
    throw new TypeError("Bound operation dispatcher requires a non-empty concurrency scope.");
  }
  return (input = {}) => dispatchOperation({
    ...input,
    concurrencyScope: boundConcurrencyScope,
    lockManager
  });
}
