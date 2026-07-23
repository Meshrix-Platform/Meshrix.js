import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStateLock(lockFilePath = "") {
  const lockDir = String(lockFilePath || "");
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (Date.now() - startedAt < DEFAULT_LOCK_TIMEOUT_MS) {
    try {
      await fs.mkdir(lockDir);
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > DEFAULT_LOCK_STALE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
      await sleep(25);
    }
  }
  const error = new Error("Model routing state lock timeout.");
  error.code = "model_routing_state_lock_timeout";
  throw error;
}

async function updateStateLocked({ userDataPath = "", lockPath, readState, writeState, update }) {
  const release = await acquireStateLock(lockPath(userDataPath));
  try {
    const state = await readState({ userDataPath });
    const next = await update(state);
    if (!next?.write) {
      return { state, next: next?.state || state };
    }
    const written = await writeState({ userDataPath, state: next.state });
    return { state, next: written };
  } finally {
    await release();
  }
}

function routeInFlightForPolicy(state = {}, policy = {}) {
  return asObject(state.inFlight?.[policy.routeId]);
}

function pruneInFlightSlots(slots = {}, policy = {}, nowMs = Date.now()) {
  const maxInFlightMs = Number(policy.rateLimit.maxInFlightMs || 0);
  return Object.fromEntries(Object.entries(asObject(slots)).filter(([, startedAt]) => {
    const startedAtMs = Date.parse(startedAt || "");
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
} = {}) {
  if (!policy.rateLimit.maxConcurrent) {
    return { reserved: false, traffic: { algorithm: "sliding_window_success_count", maxConcurrent: 0 } };
  }
  const reservedAt = nowIso();
  const result = await updateStateLocked({
    userDataPath,
    lockPath,
    readState,
    writeState,
    update: (state) => {
      const routeInFlight = routeInFlightForPolicy(state, policy);
      const slots = pruneInFlightSlots(routeInFlight.slots, policy);
      const inFlightCount = Object.keys(slots).length;
      if (inFlightCount >= policy.rateLimit.maxConcurrent) {
        const error = new Error(`Model routing concurrency limit exceeded for ${policy.routeId}.`);
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
} = {}) {
  if (!reserved || !policy.rateLimit.maxConcurrent) {
    return;
  }
  await updateStateLocked({
    userDataPath,
    lockPath,
    readState,
    writeState,
    update: (state) => {
      const routeInFlight = routeInFlightForPolicy(state, policy);
      const slots = pruneInFlightSlots(routeInFlight.slots, policy);
      delete slots[routeCallId];
      const nextInFlight = { ...asObject(state.inFlight) };
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
