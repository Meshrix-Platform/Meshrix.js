#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_CACHE_DIR: any = ".cache/meshrix/npm-artifacts";
const MANIFEST_FILE_NAME: any = "checkpoint-manifest.json";
const REPORT_PATH: any = "build/reports/npm-artifact-cache.json";
const DEFAULT_MAX_RETRIES: any = 4;
const DEFAULT_TIMEOUT_MS: any = 120_000;

function parseArgs(argv: any = process.argv.slice(2)) : any {
  const parsed: Record<string, any> = {};
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const separator: any = arg.indexOf("=");
    if (separator > 2) {
      parsed[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key: any = arg.slice(2);
    const next: any = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function toInteger(value?: any, fallback?: any, { min = 0 }: Record<string, any> = {}) : any {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed: any = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid integer option: ${value}`);
  }
  return parsed;
}

function repoRelative(absolutePath?: any) : any {
  const relative: any = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "[external-cache]";
  }
  return relative;
}

function assertUntrackedCachePath(cacheDir?: any) : any {
  const relative: any = repoRelative(cacheDir);
  if (relative === "[external-cache]") {
    return;
  }
  if (!relative.startsWith(".cache/")) {
    throw new Error("NPM artifact cache inside the repository must live under .cache/ so checkpoint data stays untracked.");
  }
}

async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function hashText(value?: any) : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function lockfileArtifacts(lockfile?: any) : any {
  const packages: any = lockfile?.packages || {};
  const artifacts: any[] = [];
  const seen: any = new Set<any>();
  for (const [packagePath, meta] of (Object.entries(packages) as [string, any][])) {
    const resolved: any = String(meta?.resolved || "").trim();
    const integrity: any = String(meta?.integrity || "").trim();
    if (!resolved || !integrity || !/^https?:\/\//i.test(resolved)) {
      continue;
    }
    const key: any = hashText(`${resolved}\n${integrity}`);
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
  artifacts.sort((a?: any, b?: any) : any => `${a.packageName}@${a.version}`.localeCompare(`${b.packageName}@${b.version}`));
  return artifacts;
}

function parseIntegrity(integrity?: any) : any {
  return String(integrity || "")
    .split(/\s+/)
    .map((item?: any) : any => {
      const separator: any = item.indexOf("-");
      if (separator <= 0) {
        return null;
      }
      const algorithm: any = item.slice(0, separator);
      const digest: any = item.slice(separator + 1);
      if (!crypto.getHashes().includes(algorithm) || !digest) {
        return null;
      }
      return { algorithm, digest };
    })
    .filter(Boolean);
}

async function digestFile(filePath?: any, algorithm?: any) : Promise<any> {
  const hash: any = crypto.createHash(algorithm);
  await new Promise((resolve?: any, reject?: any) : any => {
    const stream: any = fsSync.createReadStream(filePath);
    stream.on("data", (chunk?: any) : any => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("base64");
}

async function verifyIntegrity(filePath?: any, integrity?: any) : Promise<any> {
  const candidates: any = parseIntegrity(integrity);
  assert.ok(candidates.length > 0, "Package lock entry has no supported integrity algorithm.");
  for (const candidate of candidates) {
    const digest: any = await digestFile(filePath, candidate.algorithm);
    if (digest === candidate.digest) {
      const stat: any = await fs.stat(filePath);
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

async function loadManifest(manifestPath?: any) : Promise<any> {
  try {
    const manifest: any = await readJson(manifestPath);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { artifacts: {} };
    }
    return { ...manifest, artifacts: manifest.artifacts || {} };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { artifacts: {} };
    }
    throw error;
  }
}

async function saveManifest(manifestPath?: any, manifest?: any) : Promise<any> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath: any = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, manifestPath);
}

async function removeIfExists(filePath?: any) : Promise<any> {
  await fs.rm(filePath, { force: true }).catch(() : any => {});
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

function writeChunk(stream?: any, chunk?: any) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    if (!stream.write(chunk)) {
      stream.once("drain", resolve);
      stream.once("error", reject);
      return;
    }
    resolve();
  });
}

async function closeStream(stream?: any) : Promise<any> {
  await new Promise((resolve?: any, reject?: any) : any => {
    stream.end((error?: any) : any => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function streamResponseToFile(response: any, filePath: any, { append, interruptAfterBytes, existingBytes }: Record<string, any>) : Promise<any> {
  const stream: any = fsSync.createWriteStream(filePath, { flags: append ? "a" : "w" });
  const reader: any = response.body?.getReader?.();
  if (!reader) {
    throw new Error("HTTP response body is not readable.");
  }
  let written: any = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk: any = Buffer.from(value);
      const absoluteWrittenAfterChunk: any = existingBytes + written + chunk.length;
      if (interruptAfterBytes > 0 && absoluteWrittenAfterChunk > interruptAfterBytes) {
        const allowed: any = Math.max(0, interruptAfterBytes - existingBytes - written);
        if (allowed > 0) {
          await writeChunk(stream, chunk.subarray(0, allowed));
          written += allowed;
        }
        const interrupted: Error & Record<string, any> = new Error("Intentional interrupted download checkpoint reached.");
        interrupted.code = "INTENTIONAL_INTERRUPT";
        interrupted.bytesWritten = existingBytes + written;
        throw interrupted;
      }
      await writeChunk(stream, chunk);
      written += chunk.length;
    }
  } finally {
    await closeStream(stream).catch(() : any => {});
    await reader.cancel().catch(() : any => {});
  }
  return written;
}

async function fetchWithTimeout(url?: any, options?: any, timeoutMs?: any) : Promise<any> {
  const controller: any = new AbortController();
  const timeout: any = setTimeout(() : any => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function artifactManifestEntry(artifact?: any, integrityResult?: any, cacheFile?: any, extra: Record<string, any> = {}) : any {
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

async function prepareArtifact({ artifact, cacheDir, manifest, options, report }: Record<string, any>) : Promise<any> {
  const cacheFile: any = `${artifact.key}.tgz`;
  const completePath: any = path.join(cacheDir, cacheFile);
  const partialPath: any = `${completePath}.part`;

  try {
    const existing: any = await verifyIntegrity(completePath, artifact.integrity);
    if (existing.ok) {
      manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, existing, cacheFile, {
        resume: { reusedVerifiedComplete: true }
      });
      report.reusedComplete += 1;
      report.verifiedBytes += existing.size;
      return;
    }
    await removeIfExists(completePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      await removeIfExists(completePath);
    }
  }

  let lastError: any = null;
  for (let attempt: any = 1; attempt <= options.maxRetries; attempt += 1) {
    let partialBytes: any = 0;
    try {
      partialBytes = (await fs.stat(partialPath).catch(() : any => ({ size: 0 }))).size || 0;
      const headers: Record<string, any> = {};
      if (partialBytes > 0) {
        headers.Range = `bytes=${partialBytes}-`;
      }
      const response: any = await fetchWithTimeout(artifact.resolved, { headers }, options.timeoutMs).catch((error?: any) : any => {
        if (options.interruptAfterBytes > 0) {
          const interrupted: Error & Record<string, any> = new Error("Intentional interrupted download checkpoint reached.");
          interrupted.code = "INTENTIONAL_INTERRUPT";
          interrupted.bytesWritten = partialBytes;
          throw interrupted;
        }
        throw error;
      });
      if (response.status === 416 && partialBytes > 0) {
        const verifiedPartial: any = await verifyIntegrity(partialPath, artifact.integrity);
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
      const rangeAccepted: any = partialBytes > 0 && response.status === 206;
      const append: any = rangeAccepted;
      if (partialBytes > 0 && !rangeAccepted) {
        await removeIfExists(partialPath);
        partialBytes = 0;
      }
      if (options.interruptAfterBytes > 0 && partialBytes >= options.interruptAfterBytes) {
        const interrupted: Error & Record<string, any> = new Error("Intentional interrupted download checkpoint reached.");
        interrupted.code = "INTENTIONAL_INTERRUPT";
        interrupted.bytesWritten = partialBytes;
        throw interrupted;
      }
      await streamResponseToFile(response, partialPath, {
        append,
        interruptAfterBytes: options.interruptAfterBytes,
        existingBytes: partialBytes
      });
      const integrityResult: any = await verifyIntegrity(partialPath, artifact.integrity);
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
    } catch (error: any) {
      if (error?.code === "INTENTIONAL_INTERRUPT") {
        const interruptedBytes: any = Number(error.bytesWritten || 0);
        manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, { ok: false }, cacheFile, {
          status: "partial",
          partialBytes: interruptedBytes,
          resume: { interruptedAfterBytes: options.interruptAfterBytes, attempt }
        });
        report.interrupted = true;
        report.partialBytes = interruptedBytes;
        throw error;
      }
      if (options.interruptAfterBytes > 0 && attempt >= options.maxRetries) {
        const interrupted: Error & Record<string, any> = new Error("Intentional interrupted download checkpoint reached.");
        interrupted.code = "INTENTIONAL_INTERRUPT";
        interrupted.bytesWritten = 0;
        manifest.artifacts[artifact.key] = artifactManifestEntry(artifact, { ok: false }, cacheFile, {
          status: "partial",
          partialBytes: 0,
          resume: { interruptedAfterBytes: options.interruptAfterBytes, attempt }
        });
        report.interrupted = true;
        report.partialBytes = 0;
        throw interrupted;
      }
      lastError = error;
      if (attempt < options.maxRetries) {
        await delay(Math.min(1000 * (2 ** (attempt - 1)), 8000));
      }
    }
  }
  throw lastError || new Error("Artifact download failed.");
}

async function main() : Promise<any> {
  const args: any = parseArgs();
  const lockfilePath: any = path.resolve(repoRoot, String(args.lockfile || "package-lock.json"));
  const cacheDir: any = path.resolve(repoRoot, String(args["cache-dir"] || DEFAULT_CACHE_DIR));
  const manifestPath: any = path.join(cacheDir, MANIFEST_FILE_NAME);
  const reportPath: any = path.resolve(repoRoot, String(args.report || REPORT_PATH));
  const limit: any = toInteger(args.limit, 0, { min: 0 });
  const packageFilter: any = String(args.package || "").trim();
  const options: Record<string, any> = {
    maxRetries: toInteger(args["max-retries"], DEFAULT_MAX_RETRIES, { min: 1 }),
    timeoutMs: toInteger(args["timeout-ms"], DEFAULT_TIMEOUT_MS, { min: 1000 }),
    interruptAfterBytes: toInteger(args["interrupt-after-bytes"], 0, { min: 0 })
  };

  assertUntrackedCachePath(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  const lockfileRaw: any = await fs.readFile(lockfilePath, "utf8");
  const lockfile: any = JSON.parse(lockfileRaw);
  const lockfileSha256: any = hashText(lockfileRaw);
  let artifacts: any = lockfileArtifacts(lockfile);
  if (packageFilter) {
    artifacts = artifacts.filter((artifact?: any) : any =>
      artifact.packageName === packageFilter || artifact.packagePath.endsWith(`/${packageFilter}`)
    );
  }
  if (limit > 0) {
    artifacts = artifacts.slice(0, limit);
  }
  if (!artifacts.length) {
    throw new Error("No npm artifacts with resolved URL and integrity were found in package-lock.json.");
  }

  const manifest: any = await loadManifest(manifestPath);
  manifest.schemaVersion = "v0.0.1:supply-chain:npm-artifact-cache-checkpoint-1";
  manifest.lockfileSha256 = lockfileSha256;
  manifest.cacheRoot = repoRelative(cacheDir);
  manifest.manifestFile = `${repoRelative(cacheDir)}/${MANIFEST_FILE_NAME}`;
  manifest.updatedAt = new Date().toISOString();
  manifest.artifacts = manifest.artifacts || {};

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:supply-chain:npm-artifact-cache-report-1",
    verifier: "tools/server-scripts/prepare-npm-artifact-cache.ts",
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
  } catch (error: any) {
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
