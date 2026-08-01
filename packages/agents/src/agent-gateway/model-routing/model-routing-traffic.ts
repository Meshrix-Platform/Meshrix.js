import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOCK_STALE_MS: any = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS: any = 2_000;

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function nowIso() : any {
  return new Date().toISOString();
}

async function sleep(ms: any = 0) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function acquireStateLock(lockFilePath: any = "") : Promise<any> {
  const lockDir: any = String(lockFilePath || "");
  const startedAt: any = Date.now();
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (Date.now() - startedAt < DEFAULT_LOCK_TIMEOUT_MS) {
    try {
      await fs.mkdir(lockDir);
      return async () : Promise<any> => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() : any => {});
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const stat: any = await fs.stat(lockDir).catch(() : any => null);
      if (stat && Date.now() - stat.mtimeMs > DEFAULT_LOCK_STALE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() : any => {});
      }
      await sleep(25);
    }
  }
  const error: Error & Record<string, any> = new Error("Model routing state lock timeout.");
  error.code = "model_routing_state_lock_timeout";
  throw error;
}

async function updateStateLocked({ userDataPath = "", lockPath, readState, writeState, update }: Record<string, any>) : Promise<any> {
  const release: any = await acquireStateLock(lockPath(userDataPath));
  try {
    const state: any = await readState({ userDataPath });
    const next: any = await update(state);
    if (!next?.write) {
      return { state, next: next?.state || state };
    }
    const written: any = await writeState({ userDataPath, state: next.state });
    return { state, next: written };
  } finally {
    await release();
  }
}

function routeInFlightForPolicy(state: Record<string, any> = {}, policy: Record<string, any> = {}) : any {
  return asObject(state.inFlight?.[policy.routeId]);
}

function pruneInFlightSlots(slots: Record<string, any> = {}, policy: Record<string, any> = {}, nowMs: any = Date.now()) : any {
  const maxInFlightMs: any = Number(policy.rateLimit.maxInFlightMs || 0);
  return Object.fromEntries((Object.entries(asObject(slots)) as [string, any][]).filter(([, startedAt]: any[]) : any => {
    const startedAtMs: any = Date.parse(startedAt || "");
    return Number.isFinite(startedAtMs) && nowMs - startedAtMs <= maxInFlightMs;
  }));
}

export async function reserveModelRoutingTrafficSlot({
  userDataPath = "",
  policy = {},
  routeCallId = "",
  lockPath,
  readState,
  writeState
}: Record<string, any> = {}) : Promise<any> {
  if (!policy.rateLimit.maxConcurrent) {
    return { reserved: false, traffic: { algorithm: "sliding_window_success_count", maxConcurrent: 0 } };
  }
  const reservedAt: any = nowIso();
  const result: any = await updateStateLocked({
    userDataPath,
    lockPath,
    readState,
    writeState,
    update: (state?: any) : any => {
      const routeInFlight: any = routeInFlightForPolicy(state, policy);
      const slots: any = pruneInFlightSlots(routeInFlight.slots, policy);
      const inFlightCount: any = Object.keys(slots).length;
      if (inFlightCount >= policy.rateLimit.maxConcurrent) {
        const error: Error & Record<string, any> = new Error(`Model routing concurrency limit exceeded for ${policy.routeId}.`);
        error.code = "model_routing_concurrency_limit_exceeded";
        error.modelRoutingTraffic = {
          algorithm: "sliding_window_success_count_with_concurrency",
          deniedReason: "concurrency_limit_exceeded",
          routeId: policy.routeId,
          maxConcurrent: policy.rateLimit.maxConcurrent,
          inFlightCount
        };
        throw error;
      }
      return {
        write: true,
        state: {
          ...state,
          inFlight: {
            ...asObject(state.inFlight),
            [policy.routeId]: {
              routeId: policy.routeId,
              updatedAt: reservedAt,
              slots: {
                ...slots,
                [routeCallId]: reservedAt
              }
            }
          }
        }
      };
    }
  });
  return {
    reserved: true,
    traffic: {
      algorithm: "sliding_window_success_count_with_concurrency",
      routeId: policy.routeId,
      maxConcurrent: policy.rateLimit.maxConcurrent,
      inFlightCount: Object.keys(routeInFlightForPolicy(result.next, policy).slots || {}).length
    }
  };
}

export async function releaseModelRoutingTrafficSlot({
  userDataPath = "",
  policy = {},
  routeCallId = "",
  reserved = false,
  lockPath,
  readState,
  writeState
}: Record<string, any> = {}) : Promise<any> {
  if (!reserved || !policy.rateLimit.maxConcurrent) {
    return;
  }
  await updateStateLocked({
    userDataPath,
    lockPath,
    readState,
    writeState,
    update: (state?: any) : any => {
      const routeInFlight: any = routeInFlightForPolicy(state, policy);
      const slots: any = pruneInFlightSlots(routeInFlight.slots, policy);
      delete slots[routeCallId];
      const nextInFlight: Record<string, any> = { ...asObject(state.inFlight) };
      if (Object.keys(slots).length > 0) {
        nextInFlight[policy.routeId] = {
          routeId: policy.routeId,
          updatedAt: nowIso(),
          slots
        };
      } else {
        delete nextInFlight[policy.routeId];
      }
      return {
        write: true,
        state: {
          ...state,
          inFlight: nextInFlight
        }
      };
    }
  });
}
