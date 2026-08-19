import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync: any = promisify(execFile);
const VENDORED_FILE_SPEC: any = /^file:vendor\/([^/]+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/u;

function packageNameFromLockPath(packagePath?: any) : any {
  const marker: any = "node_modules/";
  const index: any = String(packagePath).lastIndexOf(marker);
  return index >= 0 ? String(packagePath).slice(index + marker.length) : "";
}

function cacheArtifactPath(cacheRoot?: any, integrity?: any) : any {
  const token: any = String(integrity || "")
    .split(/\s+/u)
    .find((candidate?: any) : any => candidate.startsWith("sha512-"));
  assert.ok(token, "npm_package_lock_integrity_invalid");
  const digest: any = Buffer.from(token.slice("sha512-".length), "base64");
  assert.equal(digest.length, 64, "npm_package_lock_integrity_invalid");
  const hex: any = digest.toString("hex");
  return {
    path: path.join(cacheRoot, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)),
    expectedDigest: digest,
    key: hex
  };
}

async function verifyCachedArtifact(filePath?: any, expectedDigest?: any) : Promise<any> {
  const sha512: any = createHash("sha512");
  const sha1: any = createHash("sha1");
  let size: any = 0;
  await new Promise((resolve?: any, reject?: any) : any => {
    const stream: any = fsSync.createReadStream(filePath);
    stream.on("data", (chunk?: any) : any => {
      size += chunk.length;
      sha512.update(chunk);
      sha1.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  assert.deepEqual(sha512.digest(), expectedDigest, "npm_package_cached_artifact_integrity_failed");
  return { size, sha1: sha1.digest("hex") };
}

function registryVersionMetadata(name?: any, meta?: any, artifact?: any) : any {
  return Object.fromEntries((Object.entries({
    name,
    version: meta.version,
    dependencies: meta.dependencies,
    optionalDependencies: meta.optionalDependencies,
    peerDependencies: meta.peerDependencies,
    peerDependenciesMeta: meta.peerDependenciesMeta,
    engines: meta.engines,
    cpu: meta.cpu,
    os: meta.os,
    bin: meta.bin,
    dist: {
      integrity: meta.integrity,
      shasum: artifact.sha1,
      tarballKey: artifact.key
    }
  }) as [string, any][]).filter(([, value]: any[]) : any => value !== undefined));
}

function parseRegistryPackageRequest(pathname?: any) : any {
  let raw: any = "";
  try {
    raw = decodeURIComponent(String(pathname || "/").replace(/^\//u, ""));
  } catch {
    return null;
  }
  if (!raw || raw.startsWith("tarballs/")) return null;
  if (raw.startsWith("@")) {
    const parts: any[] = raw.split("/");
    if (parts.length < 2 || !parts[1]) return { name: raw, version: "" };
    return { name: `${parts[0]}/${parts[1]}`, version: parts.slice(2).join("/") };
  }
  const slash: any = raw.indexOf("/");
  if (slash < 0) return { name: raw, version: "" };
  return { name: raw.slice(0, slash), version: raw.slice(slash + 1) };
}

function rewriteFileVendorSpecs(dependencies?: any) : any {
  if (!dependencies || typeof dependencies !== "object") return false;
  let changed: any = false;
  for (const [name, spec] of Object.entries(dependencies)) {
    const match: any = String(spec).match(VENDORED_FILE_SPEC);
    if (!match) continue;
    const unscoped: any = String(name).includes("/")
      ? String(name).slice(String(name).lastIndexOf("/") + 1)
      : String(name);
    if (match[1] !== unscoped) continue;
    dependencies[name] = match[2];
    changed = true;
  }
  return changed;
}

export async function rewritePackedVendoredFileDependencies(tarballPath?: any) : Promise<any> {
  const workRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "lock-backed-pack-rewrite-"));
  try {
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", workRoot]);
    const manifestPath: any = path.join(workRoot, "package", "package.json");
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const changed: any = ["dependencies", "optionalDependencies", "peerDependencies"]
      .map((field?: any) : any => rewriteFileVendorSpecs(manifest[field]))
      .some(Boolean);
    if (!changed) return false;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await execFileAsync("tar", ["-czf", tarballPath, "-C", workRoot, "package"]);
    return true;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

function registerLockPackage(
  packages?: any,
  tarballs?: any,
  name?: any,
  version?: any,
  meta?: any,
  artifact?: any
) : any {
  tarballs.set(artifact.key, artifact);
  const versions: any = packages.get(name) || new Map<any, any>();
  const existing: any = versions.get(version);
  const metadata: any = registryVersionMetadata(name, meta, artifact);
  if (existing) {
    assert.equal(
      existing.dist.integrity,
      metadata.dist.integrity,
      "npm_package_lock_version_integrity_conflict"
    );
  } else {
    versions.set(version, metadata);
  }
  packages.set(name, versions);
}

async function extraTarballMetadata(tarballPath?: any) : Promise<any> {
  const sha512: any = createHash("sha512");
  const sha1: any = createHash("sha1");
  let size: any = 0;
  await new Promise((resolve?: any, reject?: any) : any => {
    const stream: any = fsSync.createReadStream(tarballPath);
    stream.on("data", (chunk?: any) : any => {
      size += chunk.length;
      sha512.update(chunk);
      sha1.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  const digest: any = sha512.digest();
  return {
    size,
    sha1: sha1.digest("hex"),
    key: digest.toString("hex"),
    integrity: `sha512-${digest.toString("base64")}`
  };
}

export async function createLockBackedNpmRegistry({
  lockPath,
  cacheRoot,
  extraTarballs = []
}: Record<string, any>) : Promise<any> {
  const lock: any = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const packages: any = new Map<any, any>();
  const tarballs: any = new Map<any, any>();
  const lockFileDirectory: any = path.dirname(path.resolve(lockPath));
  for (const [packagePath, meta] of (Object.entries(lock.packages || {}) as [string, any][])) {
    const resolved: any = String(meta?.resolved || "");
    const integrity: any = String(meta?.integrity || "");
    if (!resolved || !integrity) continue;
    const name: any = String(meta.name || packageNameFromLockPath(packagePath));
    const version: any = String(meta.version || "");
    assert.ok(name && version, "npm_package_lock_metadata_incomplete");
    let artifact: Record<string, any>;
    if (resolved.startsWith("file:")) {
      const tarballPath: any = path.resolve(lockFileDirectory, resolved.slice("file:".length));
      const cached: any = cacheArtifactPath(cacheRoot, integrity);
      let verified: any;
      try {
        verified = await verifyCachedArtifact(tarballPath, cached.expectedDigest);
      } catch (error: any) {
        if (meta.optional === true && error?.code === "ENOENT") continue;
        throw error;
      }
      artifact = {
        key: cached.key,
        path: tarballPath,
        size: verified.size,
        sha1: verified.sha1
      };
    } else if (/^https?:/u.test(resolved)) {
      const resolvedUrl: any = new URL(resolved);
      assert.equal(resolvedUrl.origin, "https://registry.npmjs.org", "npm_package_lock_registry_untrusted");
      const cached: any = cacheArtifactPath(cacheRoot, integrity);
      let verified: any;
      try {
        verified = await verifyCachedArtifact(cached.path, cached.expectedDigest);
      } catch (error: any) {
        if (meta.optional === true && error?.code === "ENOENT") continue;
        throw error;
      }
      artifact = {
        key: cached.key,
        path: cached.path,
        size: verified.size,
        sha1: verified.sha1
      };
    } else {
      continue;
    }
    registerLockPackage(packages, tarballs, name, version, meta, artifact);
  }
  assert.ok(packages.size > 0 && tarballs.size > 0, "npm_package_lock_registry_empty");
  for (const extra of Array.isArray(extraTarballs) ? extraTarballs : []) {
    const name: any = String(extra?.name || "");
    const version: any = String(extra?.version || "");
    const tarballPath: any = String(extra?.tarballPath || "");
    assert.ok(name && version && tarballPath, "npm_package_extra_tarball_incomplete");
    const hashed: any = await extraTarballMetadata(tarballPath);
    const artifact: Record<string, any> = {
      key: hashed.key,
      path: tarballPath,
      size: hashed.size,
      sha1: hashed.sha1
    };
    tarballs.set(artifact.key, artifact);
    const versions: any = packages.get(name) || new Map<any, any>();
    versions.set(version, {
      name,
      version,
      dist: {
        integrity: hashed.integrity,
        shasum: hashed.sha1,
        tarballKey: artifact.key
      }
    });
    packages.set(name, versions);
  }

  const server: any = createServer((request?: any, response?: any) : any => {
    const requestUrl: any = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname.startsWith("/tarballs/")) {
      const key: any = requestUrl.pathname.slice("/tarballs/".length).replace(/\.tgz$/u, "");
      const artifact: any = tarballs.get(key);
      if (!artifact) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(artifact.size),
        "cache-control": "no-store"
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream: any = fsSync.createReadStream(artifact.path);
      stream.once("error", () : any => response.destroy());
      stream.pipe(response);
      return;
    }

    const parsed: any = parseRegistryPackageRequest(requestUrl.pathname);
    if (!parsed?.name) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"bad_request"}');
      return;
    }
    const versions: any = packages.get(parsed.name);
    if (!versions) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
      return;
    }
    const address: any = server.address();
    const origin: any = `http://127.0.0.1:${address.port}`;
    const renderVersion: any = (version?: any, metadata?: any) : any => ({
      ...metadata,
      dist: {
        ...metadata.dist,
        tarball: `${origin}/tarballs/${metadata.dist.tarballKey}.tgz`
      }
    });
    if (parsed.version) {
      const metadata: any = versions.get(parsed.version);
      if (!metadata) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
        return;
      }
      const payload: any = JSON.stringify(renderVersion(parsed.version, metadata));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
        "cache-control": "no-store"
      });
      response.end(payload);
      return;
    }
    const renderedVersions: any = Object.fromEntries(
      [...versions.entries()].map(([version, metadata]: any[]) : any => [
        version,
        renderVersion(version, metadata)
      ])
    );
    const versionNames: any = Object.keys(renderedVersions).sort((left?: any, right?: any) : any =>
      left.localeCompare(right, "en", { numeric: true })
    );
    const payload: any = JSON.stringify({
      name: parsed.name,
      "dist-tags": { latest: versionNames.at(-1) },
      versions: renderedVersions
    });
    response.writeHead(200, {
      "content-type": "application/vnd.npm.install-v1+json",
      "content-length": String(Buffer.byteLength(payload)),
      "cache-control": "no-store"
    });
    response.end(payload);
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: any = server.address();
  return {
    registry: `http://127.0.0.1:${address.port}/`,
    packageCount: packages.size,
    artifactCount: tarballs.size,
    close: () : any => new Promise((resolve?: any, reject?: any) : any =>
      server.close((error?: any) : any => error ? reject(error) : resolve())
    )
  };
}
