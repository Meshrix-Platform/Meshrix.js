import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_PACKAGE_MANIFEST: any = "meshrix-source-package-manifest.json";
const SOURCE_PACKAGE_SCHEMA: any = "v0.0.1:release:source-package-manifest-4";

function resolveGitRepoRoot(repoRoot?: any) : any {
  const resolvedRepoRoot: any = path.resolve(repoRoot);
  const acceptanceRoot: any = String(process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT || "").trim();
  if (process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER === "1" && acceptanceRoot) {
    try {
      const gitMarker: any = fs.statSync(path.join(resolvedRepoRoot, ".git"));
      if (gitMarker.isDirectory() || gitMarker.isFile()) {
        return resolvedRepoRoot;
      }
    } catch {
      // Generation workspaces without a Git marker resolve against the authoritative repository.
    }
    return path.resolve(acceptanceRoot);
  }
  return resolvedRepoRoot;
}

export { resolveGitRepoRoot };

function normalizedExcludedPaths(exclude: any = []) : any {
  return new Set<any>(exclude.map((value?: any) : any => String(value || "").replace(/\\/gu, "/")));
}

function assertPackagedSourcePath(relativePath?: any) : any {
  const normalized: any = String(relativePath || "").replace(/\\/gu, "/");
  const segments: any = normalized.split("/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\\") ||
      segments.some((segment?: any) : any => !segment || segment === "." || segment === "..")) {
    throw new Error("Packaged source manifest contains an invalid path");
  }
  return normalized;
}

function readVerifiedSourcePackageManifest(repoRoot?: any) : any {
  const manifestPath: any = path.join(repoRoot, SOURCE_PACKAGE_MANIFEST);
  let manifest: any;
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
  const files: any[] = [];
  const seen: any = new Set<any>();
  const packageHash: any = crypto.createHash("sha256");
  for (const entry of manifest.files) {
    const relativePath: any = assertPackagedSourcePath(entry?.path);
    if (seen.has(relativePath) || !Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(entry?.sha256 || ""))) {
      throw new Error("Packaged source provenance is invalid");
    }
    seen.add(relativePath);
    const absolutePath: any = path.join(repoRoot, ...relativePath.split("/"));
    const stats: any = fs.lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.bytes) {
      throw new Error("Packaged source content does not match its provenance");
    }
    const sha256: any = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error("Packaged source content does not match its provenance");
    }
    const verifiedEntry: Readonly<Record<string, any>> = Object.freeze({ path: relativePath, bytes: entry.bytes, sha256 });
    files.push(verifiedEntry);
    packageHash.update(`${relativePath}\0${entry.bytes}\0${sha256}\n`);
  }
  files.sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
  if (packageHash.digest("hex") !== manifest.packageSha256) {
    throw new Error("Packaged source provenance digest is invalid");
  }
  return Object.freeze({ sourceRevision: manifest.sourceRevision, sourceTreeDigest: manifest.sourceTreeDigest, files });
}

function packagedSourceTreeDigest(repoRoot?: any, { exclude = [] }: Record<string, any> = {}) : any {
  const manifest: any = readVerifiedSourcePackageManifest(repoRoot);
  const excluded: any = normalizedExcludedPaths(exclude);
  if (excluded.size === 0) return manifest.sourceTreeDigest;
  const hash: any = crypto.createHash("sha256");
  for (const entry of manifest.files) {
    if (!excluded.has(entry.path)) hash.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function currentSourceTreeDigest(repoRoot?: any, { exclude = [] }: Record<string, any> = {}) : any {
  const gitRepoRoot: any = resolveGitRepoRoot(repoRoot);
  const result: any = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: gitRepoRoot,
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) return packagedSourceTreeDigest(gitRepoRoot, { exclude });
  const excluded: any = normalizedExcludedPaths(exclude);
  const files: any = result.stdout.toString("utf8").split("\0").filter(Boolean)
    .filter((relativePath?: any) : any => !excluded.has(relativePath))
    .sort();
  const hash: any = crypto.createHash("sha256");
  for (const relativePath of files) {
    const absolutePath: any = path.join(gitRepoRoot, ...relativePath.split("/"));
    let stats: any;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (error: any) {
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

export function currentRepositoryRevision(repoRoot?: any) : any {
  const gitRepoRoot: any = resolveGitRepoRoot(repoRoot);
  const result: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: gitRepoRoot,
    encoding: "utf8",
    windowsHide: true
  });
  const revision: any = String(result.stdout || "").trim();
  if (result.status === 0 && /^[a-f0-9]{40,64}$/u.test(revision)) return revision;
  return readVerifiedSourcePackageManifest(gitRepoRoot).sourceRevision;
}

export function sourceFileDigest(repoRoot?: any, relativePath?: any) : any {
  const normalized: any = String(relativePath || "").replace(/\\/gu, "/");
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new TypeError("Source evidence path must be repository-relative");
  }
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(repoRoot, normalized))).digest("hex")}`;
}

export function createSourceEvidenceContext(repoRoot?: any, { verifier, commandId, exclude = [] }: Record<string, any> = {}) : any {
  const normalizedVerifier: any = String(verifier || "").replace(/\\/gu, "/");
  const normalizedCommandId: any = String(commandId || "").trim();
  if (!normalizedCommandId) throw new TypeError("Source evidence commandId is required");
  return Object.freeze({
    sourceRevision: currentRepositoryRevision(repoRoot),
    sourceTreeDigest: currentSourceTreeDigest(repoRoot, { exclude }),
    verifier: normalizedVerifier,
    verifierDigest: sourceFileDigest(repoRoot, normalizedVerifier),
    commandId: normalizedCommandId
  });
}
