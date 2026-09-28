export * from "./api-key-distribution-common.ts";

const API_KEY_COMMANDS: readonly string[] = Object.freeze([
  "getIssuerScopes", "list", "listAudienceGrants", "create", "rotate", "revoke", "authenticateRuntime",
  "revalidateAuthorization", "authorizeOperation", "reserveEffect", "revalidateEffect",
  "releaseEffect", "explainLookupPlan"
]);

function apiKeyProviderClosedError(): Error & Record<string, any> {
  return Object.assign(new Error("API Key provider is closing."), { code: "sqlite_lane_closed" });
}

function invocationAbortedError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("API Key tool execution was cancelled.");
  error.name = "AbortError";
  return error;
}

function combineInvocationSignals(callerSignal: any, ownerSignal: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const parents = [callerSignal, ownerSignal].filter(Boolean) as AbortSignal[];
  for (const parent of parents) {
    if (typeof parent.aborted !== "boolean" || typeof parent.addEventListener !== "function" ||
        typeof parent.removeEventListener !== "function") {
      throw new TypeError("API Key invocation signal must be an AbortSignal.");
    }
  }
  const listeners = new Map<AbortSignal, () => void>();
  for (const parent of parents) {
    const abort = () : void => {
      if (!controller.signal.aborted) controller.abort(parent.reason);
    };
    listeners.set(parent, abort);
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() : void {
      for (const [parent, listener] of listeners) parent.removeEventListener("abort", listener);
    }
  };
}

function isUncertainExecutionLaneFailure(error: any): boolean {
  const code = String(error?.code || "");
  return code.startsWith("sqlite_lane_") && ![
    "sqlite_lane_capacity_exceeded",
    "sqlite_lane_command_rejected",
    "sqlite_lane_payload_rejected"
  ].includes(code);
}

export function createApiKeyDistributionProvider({ store, changeListener = null }: Record<string, any> = {}) : any {
  if (!store || typeof store.executeApiKey !== "function") {
    throw new Error("API Key distribution SQLite lane is unavailable.");
  }
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let ownerFailure: any = null;
  const ownerAbort = new AbortController();
  const activeCalls = new Set<Promise<any>>();

  function register<T>(run: () => Promise<T> | T): Promise<T> {
    if (closing) return Promise.reject(apiKeyProviderClosedError());
    let resolveCall: (value: T | PromiseLike<T>) => void;
    let rejectCall: (reason?: any) => void;
    const call = new Promise<T>((resolve, reject) => {
      resolveCall = resolve;
      rejectCall = reject;
    });
    activeCalls.add(call);
    void Promise.resolve().then(run).then(resolveCall!, rejectCall!).finally(() => {
      activeCalls.delete(call);
    }).catch(() => {});
    return call;
  }

  async function executeApiKey(kind: string, input: any = {}): Promise<any> {
    try {
      return await store.executeApiKey(kind, input);
    } catch (error: any) {
      if (isUncertainExecutionLaneFailure(error)) ownerFailure ||= error;
      throw error;
    }
  }

  async function releaseReservation(lease: any): Promise<void> {
    while (true) {
      try {
        await executeApiKey("releaseEffect", lease);
        return;
      } catch (error: any) {
        if (String(error?.code || "") !== "sqlite_lane_capacity_exceeded") throw error;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  async function withEffectReservation({
    authorization,
    operation,
    signal = null,
    execute
  }: Record<string, any>): Promise<any> {
    if (typeof execute !== "function") throw new TypeError("API Key invocation requires an execution callback.");
    return register(async () : Promise<any> => {
      const combined = combineInvocationSignals(signal, ownerAbort.signal);
      let reservation: any = null;
      try {
        if (combined.signal.aborted) throw invocationAbortedError(combined.signal);
        reservation = await executeApiKey("reserveEffect", { authorization, operation });
        if (combined.signal.aborted) throw invocationAbortedError(combined.signal);
        const revalidate = () : Promise<any> => executeApiKey("revalidateEffect", reservation);
        await revalidate();
        if (combined.signal.aborted) throw invocationAbortedError(combined.signal);
        return await execute({ signal: combined.signal, revalidate });
      } catch (error: any) {
        if (isUncertainExecutionLaneFailure(error)) ownerFailure ||= error;
        throw error;
      } finally {
        combined.dispose();
        if (reservation) {
          try {
            await releaseReservation(reservation);
          } catch (error: any) {
            ownerFailure ||= error;
            throw error;
          }
        }
      }
    });
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    ownerAbort.abort();
    closePromise = (async () : Promise<void> => {
      await Promise.allSettled([...activeCalls]);
      if (ownerFailure) throw ownerFailure;
    })();
    return closePromise;
  }

  store.registerApiKeyExecutionOwnerClose?.(close);
  const methods = Object.fromEntries(API_KEY_COMMANDS.map((kind?: any) : any => [
    kind,
    (input: any = {}) : Promise<any> => register(async () : Promise<any> => {
      const result: any = await executeApiKey(kind, input);
      if (["create", "rotate", "revoke"].includes(kind) && typeof changeListener === "function") {
        await changeListener({
          reasonCode: `api_key_${kind}`,
          type: `api_key_${kind}`,
          grantId: String(result?.record?.workloadPrincipalId || result?.workloadPrincipalId || "")
        });
      }
      return result;
    })
  ]));
  return Object.freeze({ ...methods, withEffectReservation, close });
}
