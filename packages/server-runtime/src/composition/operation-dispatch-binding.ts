import { dispatchOperation } from "./dispatch-operation-core.ts";

export function bindOperationDispatcher({ lockManager, concurrencyScope = "default" }: Record<string, any> = {}) : any {
  if (!lockManager || typeof lockManager.acquire !== "function") {
    throw new TypeError("Bound operation dispatcher requires a LockManager.");
  }
  const boundConcurrencyScope: any = String(concurrencyScope || "").trim();
  if (!boundConcurrencyScope) {
    throw new TypeError("Bound operation dispatcher requires a non-empty concurrency scope.");
  }
  return (input: Record<string, any> = {}) : any => dispatchOperation({
    ...input,
    concurrencyScope: boundConcurrencyScope,
    lockManager
  });
}
