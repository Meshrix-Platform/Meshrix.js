import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import v8 from "node:v8";

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function requireExposedGc() {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Memory smoke tests require Node.js --expose-gc so retained heap can be measured after GC.");
  }
}

export async function forceGc({ rounds = 4, settleMs = 20 } = {}) {
  if (typeof globalThis.gc !== "function") return;
  for (let index = 0; index < rounds; index += 1) {
    globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

export function captureMemorySample(label, metadata = {}) {
  const usage = process.memoryUsage();
  return {
    label,
    metadata,
    capturedAt: new Date().toISOString(),
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers
  };
}

function linearSlope(samples, field) {
  if (samples.length < 2) return 0;
  const n = samples.length;
  const xs = samples.map((_, index) => index);
  const ys = samples.map((sample) => Number(sample[field] || 0));
  const xMean = xs.reduce((sum, value) => sum + value, 0) / n;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / n;
  const numerator = xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0);
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  return denominator ? numerator / denominator : 0;
}

export function analyzeMemorySamples(samples, budgets = {}) {
  if (samples.length < 2) {
    return {
      ok: false,
      failures: ["Need at least two memory samples."]
    };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const deltas = {
    rss: last.rss - first.rss,
    heapUsed: last.heapUsed - first.heapUsed,
    external: last.external - first.external,
    arrayBuffers: last.arrayBuffers - first.arrayBuffers
  };
  const slopes = {
    rss: linearSlope(samples, "rss"),
    heapUsed: linearSlope(samples, "heapUsed"),
    external: linearSlope(samples, "external"),
    arrayBuffers: linearSlope(samples, "arrayBuffers")
  };
  const checks = [
    ["rss", deltas.rss, budgets.maxRssDeltaBytes],
    ["heapUsed", deltas.heapUsed, budgets.maxHeapUsedDeltaBytes],
    ["external", deltas.external, budgets.maxExternalDeltaBytes],
    ["arrayBuffers", deltas.arrayBuffers, budgets.maxArrayBuffersDeltaBytes],
    ["rssSlope", slopes.rss, budgets.maxRssSlopeBytes],
    ["heapUsedSlope", slopes.heapUsed, budgets.maxHeapUsedSlopeBytes]
  ];
  const failures = checks
    .filter(([, actual, budget]) => Number.isFinite(Number(budget)) && actual > Number(budget))
    .map(([name, actual, budget]) => `${name} ${formatBytes(actual)} exceeded ${formatBytes(budget)}`);
  return {
    ok: failures.length === 0,
    failures,
    deltas,
    slopes
  };
}

export async function writeMemoryReport(reportPath, report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function writeHeapSnapshotOnFailure(reportPath) {
  const snapshotPath = reportPath.replace(/\.json$/u, ".heapsnapshot");
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  return v8.writeHeapSnapshot(snapshotPath);
}
