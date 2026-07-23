import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";

function boundedInteger(value, fallback, { min = 1, max = 10 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function downloadRetryAttempts(env = process.env) {
  return boundedInteger(env.LICO_DOWNLOAD_RETRY_ATTEMPTS, 3, { min: 1, max: 10 });
}

export function retryDelayMs(attemptIndex = 0, env = process.env) {
  const baseMs = boundedInteger(env.LICO_DOWNLOAD_RETRY_DELAY_MS, 500, { min: 50, max: 30_000 });
  const cappedAttempt = Math.min(6, Math.max(0, Math.trunc(Number(attemptIndex) || 0)));
  return Math.min(30_000, baseMs * (2 ** cappedAttempt));
}

export async function fileSize(filePath = "") {
  if (!filePath) {
    return 0;
  }
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

export function normalizeSha256(value = "") {
  const normalized = String(value || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

export async function verifyFileSha256(filePath = "", expectedSha256 = "") {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) {
    return {
      ok: false,
      expected: "",
      actual: "",
      error: "invalid_expected_sha256"
    };
  }
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const actual = hash.digest("hex");
  return {
    ok: actual === expected,
    expected,
    actual
  };
}

export function outputMentionsRangeUnsupported(output = "") {
  const text = String(output || "").toLowerCase();
  return text.includes("416") ||
    /range.*not.*satisf/.test(text) ||
    /requested range/.test(text) ||
    /does not support.*range/.test(text) ||
    /range.*unsupported/.test(text);
}
