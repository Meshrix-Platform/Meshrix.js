import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import pprof from "@datadog/pprof";

const MESSAGE_KIND = "meshrix.resource-discipline.memory-sample";
const intervalBytes = positiveInteger(
  process.env.MESHRIX_MEMORY_PROFILE_INTERVAL_BYTES,
  256 * 1024,
  16 * 1024 * 1024
);
const stackDepth = positiveInteger(
  process.env.MESHRIX_MEMORY_PROFILE_STACK_DEPTH,
  64,
  256
);
const gcPasses = positiveInteger(process.env.MESHRIX_MEMORY_GC_PASSES, 3, 8);
const profilePath = String(process.env.MESHRIX_MEMORY_PROFILE_PATH || "").trim();

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function safeReasonCode(error, fallback = "memory_profile_failed") {
  const value = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function collectGarbage() {
  if (typeof globalThis.gc !== "function") {
    const error = new Error("Explicit garbage collection is unavailable.");
    error.code = "EXPLICIT_GC_UNAVAILABLE";
    throw error;
  }
  for (let pass = 0; pass < gcPasses; pass += 1) {
    globalThis.gc();
    await immediate();
  }
}

function profileSampleIndex(profile, name) {
  const strings = profile?.stringTable?.strings || [];
  return (profile?.sampleType || []).findIndex((entry) => strings[entry.type] === name);
}

function sumProfileValue(profile, valueIndex) {
  if (valueIndex < 0) return 0;
  return (profile?.sample || []).reduce((total, sample) => {
    const value = Number(sample?.value?.[valueIndex] || 0);
    return Number.isFinite(value) && value > 0 ? total + value : total;
  }, 0);
}

async function sampleMemory({ captureProfile = false } = {}) {
  await collectGarbage();
  const memory = process.memoryUsage();
  const profile = pprof.heap.profile();
  const inUseSpaceIndex = profileSampleIndex(profile, "inuse_space");
  const inUseObjectsIndex = profileSampleIndex(profile, "inuse_objects");
  let encodedBytes = 0;
  let profileSha256 = "";
  if (captureProfile) {
    if (!profilePath || !path.isAbsolute(profilePath)) {
      const error = new Error("A private absolute profile path is required.");
      error.code = "MEMORY_PROFILE_PATH_REQUIRED";
      throw error;
    }
    const encoded = pprof.encodeSync(profile);
    encodedBytes = encoded.byteLength;
    profileSha256 = crypto.createHash("sha256").update(encoded).digest("hex");
    await fs.writeFile(profilePath, encoded, { mode: 0o600 });
  }
  return {
    memory,
    profile: {
      framework: "@datadog/pprof",
      inUseBytes: sumProfileValue(profile, inUseSpaceIndex),
      inUseObjects: sumProfileValue(profile, inUseObjectsIndex),
      sampleCount: Array.isArray(profile?.sample) ? profile.sample.length : 0,
      encodedBytes,
      profileSha256
    }
  };
}

function send(message) {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(message, () => {});
}

pprof.heap.start(intervalBytes, stackDepth);

let sampleQueue = Promise.resolve();
process.on("message", (message) => {
  if (message?.kind !== MESSAGE_KIND || !Number.isSafeInteger(message.id)) return;
  sampleQueue = sampleQueue.catch(() => null).then(async () => {
    try {
      const result = await sampleMemory({ captureProfile: message.captureProfile === true });
      send({ kind: MESSAGE_KIND, id: message.id, ok: true, ...result });
    } catch (error) {
      send({
        kind: MESSAGE_KIND,
        id: message.id,
        ok: false,
        reasonCode: safeReasonCode(error)
      });
    }
  });
});

process.once("exit", () => {
  try {
    pprof.heap.stop();
  } catch {
    // Process exit is already authoritative; profiler shutdown is best effort.
  }
});
