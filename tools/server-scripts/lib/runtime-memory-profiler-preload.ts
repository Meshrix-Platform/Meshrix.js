import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import pprof from "@datadog/pprof";

const MESSAGE_KIND: any = "meshrix.resource-discipline.memory-sample";
const intervalBytes: any = positiveInteger(
  process.env.MESHRIX_MEMORY_PROFILE_INTERVAL_BYTES,
  256 * 1024,
  16 * 1024 * 1024
);
const stackDepth: any = positiveInteger(
  process.env.MESHRIX_MEMORY_PROFILE_STACK_DEPTH,
  64,
  256
);
const gcPasses: any = positiveInteger(process.env.MESHRIX_MEMORY_GC_PASSES, 3, 8);
const profilePath: any = String(process.env.MESHRIX_MEMORY_PROFILE_PATH || "").trim();

function positiveInteger(value?: any, fallback?: any, maximum?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function safeReasonCode(error?: any, fallback: any = "memory_profile_failed") : any {
  const value: any = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function immediate() : any {
  return new Promise((resolve?: any) : any => setImmediate(resolve));
}

async function collectGarbage() : Promise<any> {
  if (typeof globalThis.gc !== "function") {
    const error: Error & Record<string, any> = new Error("Explicit garbage collection is unavailable.");
    error.code = "EXPLICIT_GC_UNAVAILABLE";
    throw error;
  }
  for (let pass: any = 0; pass < gcPasses; pass += 1) {
    globalThis.gc();
    await immediate();
  }
}

function profileSampleIndex(profile?: any, name?: any) : any {
  const strings: any = profile?.stringTable?.strings || [];
  return (profile?.sampleType || []).findIndex((entry?: any) : any => strings[entry.type] === name);
}

function sumProfileValue(profile?: any, valueIndex?: any) : any {
  if (valueIndex < 0) return 0;
  return (profile?.sample || []).reduce((total?: any, sample?: any) : any => {
    const value: any = Number(sample?.value?.[valueIndex] || 0);
    return Number.isFinite(value) && value > 0 ? total + value : total;
  }, 0);
}

async function sampleMemory({ captureProfile = false }: Record<string, any> = {}) : Promise<any> {
  await collectGarbage();
  const memory: any = process.memoryUsage();
  const profile: any = pprof.heap.profile();
  const inUseSpaceIndex: any = profileSampleIndex(profile, "inuse_space");
  const inUseObjectsIndex: any = profileSampleIndex(profile, "inuse_objects");
  let encodedBytes: any = 0;
  let profileSha256: any = "";
  if (captureProfile) {
    if (!profilePath || !path.isAbsolute(profilePath)) {
      const error: Error & Record<string, any> = new Error("A private absolute profile path is required.");
      error.code = "MEMORY_PROFILE_PATH_REQUIRED";
      throw error;
    }
    const encoded: any = pprof.encodeSync(profile);
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

function send(message?: any) : any {
  if (typeof process.send !== "function" || !process.connected) return;
  process.send(message, () : any => {});
}

pprof.heap.start(intervalBytes, stackDepth);

let sampleQueue: any = Promise.resolve();
process.on("message", (message?: any) : any => {
  if (message?.kind !== MESSAGE_KIND || !Number.isSafeInteger(message.id)) return;
  sampleQueue = sampleQueue.catch(() : any => null).then(async () : Promise<any> => {
    try {
      const result: any = await sampleMemory({ captureProfile: message.captureProfile === true });
      send({ kind: MESSAGE_KIND, id: message.id, ok: true, ...result });
    } catch (error: any) {
      send({
        kind: MESSAGE_KIND,
        id: message.id,
        ok: false,
        reasonCode: safeReasonCode(error)
      });
    }
  });
});

process.once("exit", () : any => {
  try {
    pprof.heap.stop();
  } catch {
    // Process exit is already authoritative; profiler shutdown is best effort.
  }
});
