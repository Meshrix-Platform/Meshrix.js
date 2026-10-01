import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";

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
  const scripts: any = meta.scripts && typeof meta.scripts === "object" ? meta.scripts : {};
  const hasInstallScript: any = meta.hasInstallScript === true
    || ["preinstall", "install", "postinstall"].some((name?: any) : any => typeof scripts[name] === "string");
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
    ...(hasInstallScript ? { hasInstallScript: true } : {}),
    dist: {
      integrity: meta.integrity,
      shasum: artifact.sha1,
      tarballKey: artifact.key
    }
  }) as [string, any][]).filter(([, value]: any[]) : any => value !== undefined));
}

function readTarNumber(header?: any, start?: any, length?: any) : any {
  const text: any = Buffer.from(header).subarray(start, start + length).toString("ascii").replace(/\0.*$/u, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePaxPath(buffer?: any) : any {
  let offset: any = 0;
  while (offset < buffer.length) {
    const separator: any = buffer.indexOf(0x20, offset);
    if (separator < 0) return "";
    const recordLength: any = Number.parseInt(buffer.subarray(offset, separator).toString("ascii"), 10);
    if (!Number.isInteger(recordLength) || recordLength <= 0 || offset + recordLength > buffer.length) return "";
    const record: any = buffer.subarray(separator + 1, offset + recordLength - 1).toString("utf8");
    if (record.startsWith("path=")) return record.slice("path=".length);
    offset += recordLength;
  }
  return "";
}

export function packageManifestFromTarball(bytes?: any) : any {
  const archive: any = gunzipSync(bytes);
  let offset: any = 0;
  let paxPath: any = "";
  while (offset + 512 <= archive.length) {
    const header: any = archive.subarray(offset, offset + 512);
    if (header.every((byte?: any) : any => byte === 0)) break;
    const name: any = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix: any = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const headerPath: any = paxPath || (prefix ? `${prefix}/${name}` : name);
    const size: any = readTarNumber(header, 124, 12);
    const contentStart: any = offset + 512;
    const contentEnd: any = contentStart + size;
    assert.ok(contentEnd <= archive.length, "npm_package_tarball_invalid");
    const type: any = String.fromCharCode(header[156] || 0);
    const content: any = archive.subarray(contentStart, contentEnd);
    if (type === "x" || type === "g") {
      paxPath = parsePaxPath(content);
    } else {
      if (headerPath === "package/package.json") {
        assert.ok(type === "0" || type === "\0", "npm_package_tarball_manifest_invalid");
        const manifest: any = JSON.parse(content.toString("utf8"));
        assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "npm_package_tarball_manifest_invalid");
        return manifest;
      }
      paxPath = "";
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("npm_package_tarball_manifest_missing");
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
  const bytes: any = await fs.readFile(tarballPath);
  return {
    size,
    sha1: sha1.digest("hex"),
    key: digest.toString("hex"),
    integrity: `sha512-${digest.toString("base64")}`,
    manifest: packageManifestFromTarball(bytes)
  };
}

export async function createLockBackedNpmRegistry({
  lockPath,
  cacheRoot,
  extraTarballs = [],
  host = "127.0.0.1",
  port = 0,
  advertisedOrigin = ""
}: Record<string, any>) : Promise<any> {
  const lock: any = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const packages: any = new Map<any, any>();
  const tarballs: any = new Map<any, any>();
  for (const [packagePath, meta] of (Object.entries(lock.packages || {}) as [string, any][])) {
    const resolved: any = String(meta?.resolved || "");
    const integrity: any = String(meta?.integrity || "");
    if (!resolved || !integrity) continue;
    const name: any = String(meta.name || packageNameFromLockPath(packagePath));
    const version: any = String(meta.version || "");
    assert.ok(name && version, "npm_package_lock_metadata_incomplete");
    assert.ok(/^https?:/u.test(resolved), "npm_package_lock_registry_untrusted");
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
    const artifact: Record<string, any> = {
      key: cached.key,
      path: cached.path,
      size: verified.size,
      sha1: verified.sha1
    };
    registerLockPackage(packages, tarballs, name, version, meta, artifact);
  }
  for (const extra of Array.isArray(extraTarballs) ? extraTarballs : []) {
    const name: any = String(extra?.name || "");
    const version: any = String(extra?.version || "");
    const tarballPath: any = String(extra?.tarballPath || "");
    assert.ok(name && version && tarballPath, "npm_package_extra_tarball_incomplete");
    const hashed: any = await extraTarballMetadata(tarballPath);
    assert.equal(hashed.manifest.name, name, "npm_package_extra_tarball_name_mismatch");
    assert.equal(hashed.manifest.version, version, "npm_package_extra_tarball_version_mismatch");
    const artifact: Record<string, any> = {
      key: hashed.key,
      path: tarballPath,
      size: hashed.size,
      sha1: hashed.sha1
    };
    registerLockPackage(packages, tarballs, name, version, {
      ...hashed.manifest,
      integrity: hashed.integrity
    }, artifact);
  }
  assert.ok(packages.size > 0 && tarballs.size > 0, "npm_package_lock_registry_empty");

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
    const origin: any = advertisedOrigin || `http://127.0.0.1:${address.port}`;
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
    server.listen(port, host, resolve);
  });
  const address: any = server.address();
  const origin: any = advertisedOrigin || `http://127.0.0.1:${address.port}`;
  return {
    registry: `${origin.replace(/\/$/u, "")}/`,
    packageCount: packages.size,
    artifactCount: tarballs.size,
    close: () : any => new Promise((resolve?: any, reject?: any) : any =>
      server.close((error?: any) : any => error ? reject(error) : resolve())
    )
  };
}
