import { MemoryLockManager } from "../../../packages/foundation/src/concurrency/lock-manager.ts";
import { bindOperationDispatcher } from "../../../packages/server-runtime/src/composition/dispatch-operation.ts";

export function createVerifierOperationDispatcher(concurrencyScope?: any) : any {
  const normalizedScope: any = String(concurrencyScope || "").trim();
  if (!normalizedScope) {
    throw new TypeError("Verifier operation concurrency scope must be explicit.");
  }
  const lockManager: any = new MemoryLockManager();
  return Object.freeze({
    operationDispatcher: bindOperationDispatcher({
      lockManager,
      concurrencyScope: normalizedScope
    }),
    operationConcurrencyScope: normalizedScope,
    close: () : any => lockManager.destroy()
  });
}
