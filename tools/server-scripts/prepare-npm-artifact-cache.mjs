#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_CACHE_DIR = ".cache/meshrix/npm-artifacts";
const MANIFEST_FILE_NAME = "checkpoint-manifest.json";
const REPORT_PATH = "build/reports/npm-artifact-cache.json";
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const separator = arg.indexOf("=");
    if (separator > 2) {
      parsed[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function toInteger(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid integer option: ${value}`);
  }
  return parsed;
}

function repoRelative(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "[external-cache]";
  }
  return relative;
}

function assertUntrackedCachePath(cacheDir) {
  const relative = repoRelative(cacheDir);
  if (relative === "[external-cache]") {
    return;
  }
  if (!relative.startsWith(".cache/")) {
    throw new Error("NPM artifact cache inside the repository must live under .cache/ so checkpoint data stays untracked.");
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function lockfileArtifacts(lockfile) {
  const packages = lockfile?.packages || {};
  const artifacts = [];
  const seen = new Set();
  for (const [packagePath, meta] of Object.entries(packages)) {
    const resolved = String(meta?.resolved || "").trim();
    const integrity = String(meta?.integrity || "").trim();
    if (!resolved || !integrity || !/^https?:\/\//i.test(resolved)) {
      continue;
    }
    const key = hashText(`${resolved}\n${integrity}`);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    artifacts.push({
      key,
      packagePath,
      packageName: String(meta?.name || packagePath.replace(/^node_modules\//, "") || "package"),
      version: String(meta?.version || ""),
      resolved,
      integrity
    });
  }
  artifacts.sort((a, b) => `${a.packageName}@${a.version}`.localeCompare(`${b.packageName}@${b.version}`));
  return artifacts;
}

function parseIntegrity(integrity) {
  return String(integrity || "")
    .split(/\s+/)
    .map((item) => {
      const separator = item.indexOf("-");
      if (separator <= 0) {
        return null;
      }
      const algorithm = item.slice(0, separator);
      const digest = item.slice(separator + 1);
      if (!crypto.getHashes().includes(algorithm) || !digest) {
        return null;
      }
      return { algorithm, digest };
    })
    .filter(Boolean);
}

async function digestFile(filePath, algorithm) {
  const hash = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("base64");
}

async function verifyIntegrity(filePath, integrity) {
  const candidates = parseIntegrity(integrity);
  assert.ok(candidates.length > 0, "Package lock entry has no supported integrity algorithm.");
  for (const candidate of candidates) {
    const digest = await digestFile(filePath, candidate.algorithm);
    if (digest === candidate.digest) {
      const stat = await fs.stat(filePath);
      return {
        ok: true,
        algorithm: candidate.algorithm,
        size: stat.size,
        digestPrefix: candidate.digest.slice(0, 16)
      };
    }
  }
  return { ok: false, algorithm: candidates[0]?.algorithm || "", size: 0, digestPrefix: "" };
}

async function loadManifest(manifestPath) {
  try {
    const manifest = await readJson(manifestPath);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { artifacts: {} };
    }
    return { ...manifest, artifacts: manifest.artifacts || {} };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { artifacts: {} };
    }
    throw error;
  }
}

async function saveManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, manifestPath);
}

async function removeIfExists(filePath) {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream.write(chunk)) {
      stream.once("drain", resolve);
      stream.once("error", reject);
      return;
    }
    resolve();
  });
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function streamResponseToFile(response, filePath, { append, interruptAfterBytes, existingBytes }) {
  const stream = fsSync.createWriteStream(filePath, { flags: append ? "a" : "w" });
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("HTTP response body is not readable.");
  }
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      const absoluteWrittenAfterChunk = existingBytes + written + chunk.length;
      if (interruptAfterBytes > 0 && absoluteWrittenAfterChunk > interruptAfterBytes) {
        const allowed = Math.max(0, interruptAfterBytes - existingBytes - written);
        if (allowed > 0) {
          await writeChunk(stream, chunk.subarray(0, allowed));
          written += allowed;
        }
        const interrupted = new Error("Intentional interrupted download checkpoint reached.");
        interrupted.code = "INTENTIONAL_INTERRUPT";
        interrupted.bytesWritten = existingBytes + written;
        throw interrupted;
      }
      await writeChunk(stream, chunk);
      written += chunk.length;
    }
  } finally {
    await closeStream(stream).catch(() => {});
    await reader.cancel().catch(() => {});
  }
  return written;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function artifactManifestEntry(artifact, integrityResult, cacheFile, extra = {}) {
  return {
    status: extra.status || "complete",
    packageName: artifact.packageName,
    version: artifact.version,
    key: artifact.key,
    cacheFile,
    size: integrityResult.size || extra.partialBytes || 0,
    integrityAlgorithm: integrityResult.algorithm || "",
    digestPrefix: integrityResult.digestPrefix || "",
    updatedAt: new Date().toISOString(),
    resume: extra.resume || {}
  };
}

async function prepareArtifact({ artifact, cacheDir, manifest, options, report }) {
  const cacheFile = `${artifact.key}.tgz`;
  const completePath = path.join(cacheDir, cacheFile);
  const partialPath = `${completePath}.part`;

  try {
    const existing = await verifyIntegrity(completePath, artifact.integrity);
    if (existing.ok) {
      manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, existing, cacheFile, {
        resume: { reusedVerifiedComplete: true }
      });
      report.reusedComplete += 1;
      report.verifiedBytes += existing.size;
      return;
    }
    await removeIfExists(completePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await removeIfExists(completePath);
    }
  }

  let lastError = null;
  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    let partialBytes = 0;
    try {
      partialBytes = (await fs.stat(partialPath).catch(() => ({ size: 0 }))).size || 0;
      const headers = {};
      if (partialBytes > 0) {
        headers.Range = `bytes=${partialBytes}-`;
      }
      const response = await fetchWithTimeout(artifact.resolved, { headers }, options.timeoutMs);
      if (response.status === 416 && partialBytes > 0) {
        const verifiedPartial = await verifyIntegrity(partialPath, artifact.integrity);
        if (verifiedPartial.ok) {
          await fs.rename(partialPath, completePath);
          manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, verifiedPartial, cacheFile, {
            resume: { rangeRequestBytes: partialBytes, responseStatus: response.status, completedFromPartial: true }
          });
          report.completed += 1;
          report.verifiedBytes += verifiedPartial.size;
          return;
        }
        await removeIfExists(partialPath);
        continue;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Artifact download failed with HTTP ${response.status}.`);
      }
      const rangeAccepted = partialBytes > 0 && response.status === 206;
      const append = rangeAccepted;
      if (partialBytes > 0 && !rangeAccepted) {
        await removeIfExists(partialPath);
        partialBytes = 0;
      }
      if (options.interruptAfterBytes > 0 && partialBytes >= options.interruptAfterBytes) {
        const interrupted = new Error("Intentional interrupted download checkpoint reached.");
        interrupted.code = "INTENTIONAL_INTERRUPT";
        interrupted.bytesWritten = partialBytes;
        throw interrupted;
      }
      await streamResponseToFile(response, partialPath, {
        append,
        interruptAfterBytes: options.interruptAfterBytes,
        existingBytes: partialBytes
      });
      const integrityResult = await verifyIntegrity(partialPath, artifact.integrity);
      if (!integrityResult.ok) {
        await removeIfExists(partialPath);
        throw new Error("Downloaded artifact failed package-lock integrity verification.");
      }
      await fs.rename(partialPath, completePath);
      manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, integrityResult, cacheFile, {
        resume: { rangeRequestBytes: partialBytes, responseStatus: response.status, rangeAccepted }
      });
      report.completed += 1;
      report.verifiedBytes += integrityResult.size;
      return;
    } catch (error) {
      if (error?.code === "INTENTIONAL_INTERRUPT") {
        const interruptedBytes = Number(error.bytesWritten || 0);
        manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, { ok: false }, cacheFile, {
          status: "partial",
          partialBytes: interruptedBytes,
          resume: { interruptedAfterBytes: options.interruptAfterBytes, attempt }
        });
        report.interrupted = true;
        report.partialBytes = interruptedBytes;
        throw error;
      }
      lastError = error;
      if (attempt < options.maxRetries) {
        await delay(Math.min(1000 * (2 ** (attempt - 1)), 8000));
      }
    }
  }
  throw lastError || new Error("Artifact download failed.");
}

async function main() {
  const args = parseArgs();
  const lockfilePath = path.resolve(repoRoot, String(args.lockfile || "package-lock.json"));
  const cacheDir = path.resolve(repoRoot, String(args["cache-dir"] || DEFAULT_CACHE_DIR));
  const manifestPath = path.join(cacheDir, MANIFEST_FILE_NAME);
  const reportPath = path.resolve(repoRoot, String(args.report || REPORT_PATH));
  const limit = toInteger(args.limit, 0, { min: 0 });
  const packageFilter = String(args.package || "").trim();
  const options = {
    maxRetries: toInteger(args["max-retries"], DEFAULT_MAX_RETRIES, { min: 1 }),
    timeoutMs: toInteger(args["timeout-ms"], DEFAULT_TIMEOUT_MS, { min: 1000 }),
    interruptAfterBytes: toInteger(args["interrupt-after-bytes"], 0, { min: 0 })
  };

  assertUntrackedCachePath(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  const lockfileRaw = await fs.readFile(lockfilePath, "utf8");
  const lockfile = JSON.parse(lockfileRaw);
  const lockfileSha256 = hashText(lockfileRaw);
  let artifacts = lockfileArtifacts(lockfile);
  if (packageFilter) {
    artifacts = artifacts.filter((artifact) =>
      artifact.packageName === packageFilter || artifact.packagePath.endsWith(`/${packageFilter}`)
    );
  }
  if (limit > 0) {
    artifacts = artifacts.slice(0, limit);
  }
  if (!artifacts.length) {
    throw new Error("No npm artifacts with resolved URL and integrity were found in package-lock.json.");
  }

  const manifest = await loadManifest(manifestPath);
  manifest.schemaVersion = "v0.0.1:supply-chain:npm-artifact-cache-checkpoint-1";
  manifest.lockfileSha256 = lockfileSha256;
  manifest.cacheRoot = repoRelative(cacheDir);
  manifest.manifestFile = `${repoRelative(cacheDir)}/${MANIFEST_FILE_NAME}`;
  manifest.updatedAt = new Date().toISOString();
  manifest.artifacts = manifest.artifacts || {};

  const report = {
    schemaVersion: "v0.0.1:supply-chain:npm-artifact-cache-report-1",
    verifier: "tools/server-scripts/prepare-npm-artifact-cache.mjs",
    lockfile: "package-lock.json",
    cacheRoot: repoRelative(cacheDir),
    algorithm: {
      source: "package-lock packages[].resolved plus packages[].integrity",
      resume: "HTTP Range is requested when a partial file exists; servers without Range restart only the partial object, never verified completed artifacts.",
      integrity: "Subresource Integrity digest from package-lock decides completion."
    },
    selectedArtifactCount: artifacts.length,
    completed: 0,
    reusedComplete: 0,
    verifiedBytes: 0,
    interrupted: false,
    partialBytes: 0
  };

  try {
    for (const artifact of artifacts) {
      await prepareArtifact({ artifact, cacheDir, manifest, options, report });
      await saveManifest(manifestPath, manifest);
    }
  } catch (error) {
    await saveManifest(manifestPath, manifest);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    report.releaseReady = false;
    report.errorCode = String(error?.code || "");
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (error?.code === "INTENTIONAL_INTERRUPT") {
      console.log("[npm-artifact-cache] interrupted checkpoint recorded");
      process.exit(75);
    }
    throw error;
  }

  report.releaseReady = true;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[npm-artifact-cache] ok selected=${report.selectedArtifactCount} completed=${report.completed} reused=${report.reusedComplete}`);
}

await main();
