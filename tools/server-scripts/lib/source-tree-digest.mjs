import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_PACKAGE_MANIFEST = "lico-source-package-manifest.json";
const SOURCE_PACKAGE_SCHEMA = "v0.0.1:release:source-package-manifest-4";

function normalizedExcludedPaths(exclude = []) {
  return new Set(exclude.map((value) => String(value || "").replace(/\\/gu, "/")));
}

function assertPackagedSourcePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Packaged source manifest contains an invalid path");
  }
  return normalized;
}

function readVerifiedSourcePackageManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, SOURCE_PACKAGE_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Unable to resolve packaged source provenance");
  }
  if (manifest?.schemaVersion !== SOURCE_PACKAGE_SCHEMA ||
      !/^[a-f0-9]{40,64}$/u.test(String(manifest?.sourceRevision || "")) ||
      !/^[a-f0-9]{64}$/u.test(String(manifest?.packageSha256 || "")) ||
      manifest?.sourceTreeDigest !== `sha256:${manifest.packageSha256}` ||
      !Array.isArray(manifest?.files)) {
    throw new Error("Packaged source provenance is invalid");
  }
  const files = [];
  const seen = new Set();
  const packageHash = crypto.createHash("sha256");
  for (const entry of manifest.files) {
    const relativePath = assertPackagedSourcePath(entry?.path);
    if (seen.has(relativePath) || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(entry?.sha256 || ""))) {
      throw new Error("Packaged source provenance is invalid");
    }
    seen.add(relativePath);
    const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
    const stats = fs.lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.bytes) {
      throw new Error("Packaged source content does not match its provenance");
    }
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error("Packaged source content does not match its provenance");
    }
    const verifiedEntry = Object.freeze({ path: relativePath, bytes: entry.bytes, sha256 });
    files.push(verifiedEntry);
    packageHash.update(`${relativePath}\0${entry.bytes}\0${sha256}\n`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (packageHash.digest("hex") !== manifest.packageSha256) {
    throw new Error("Packaged source provenance digest is invalid");
  }
  return Object.freeze({ sourceRevision: manifest.sourceRevision, sourceTreeDigest: manifest.sourceTreeDigest, files });
}

function packagedSourceTreeDigest(repoRoot, { exclude = [] } = {}) {
  const manifest = readVerifiedSourcePackageManifest(repoRoot);
  const excluded = normalizedExcludedPaths(exclude);
  if (excluded.size === 0) return manifest.sourceTreeDigest;
  const hash = crypto.createHash("sha256");
  for (const entry of manifest.files) {
    if (!excluded.has(entry.path)) hash.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function currentSourceTreeDigest(repoRoot, { exclude = [] } = {}) {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) return packagedSourceTreeDigest(repoRoot, { exclude });
  const excluded = normalizedExcludedPaths(exclude);
  const files = result.stdout.toString("utf8").split("\0").filter(Boolean)
    .filter((relativePath) => !excluded.has(relativePath))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, ...relativePath.split("/"));
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(absolutePath));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function currentRepositoryRevision(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  const revision = String(result.stdout || "").trim();
  if (result.status === 0 && /^[a-f0-9]{40,64}$/u.test(revision)) return revision;
  return readVerifiedSourcePackageManifest(repoRoot).sourceRevision;
}

export function sourceFileDigest(repoRoot, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/gu, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new TypeError("Source evidence path must be repository-relative");
  }
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(repoRoot, normalized))).digest("hex")}`;
}

export function createSourceEvidenceContext(repoRoot, { verifier, commandId, exclude = [] } = {}) {
  const normalizedVerifier = String(verifier || "").replace(/\\/gu, "/");
  const normalizedCommandId = String(commandId || "").trim();
  if (!normalizedCommandId) throw new TypeError("Source evidence commandId is required");
  return Object.freeze({
    sourceRevision: currentRepositoryRevision(repoRoot),
    sourceTreeDigest: currentSourceTreeDigest(repoRoot, { exclude }),
    verifier: normalizedVerifier,
    verifierDigest: sourceFileDigest(repoRoot, normalizedVerifier),
    commandId: normalizedCommandId
  });
}
