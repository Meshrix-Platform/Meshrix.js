import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  assertArtifactTransitPort,
  parseArtifactTransitReference
} from "#lico/foundation/storage/artifact-transit-port";

const ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function artifactError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.reasonCode = code;
  error.status = status;
  return error;
}

function subjectKey(subject = {}) {
  const subjectRef = String(subject.subjectId || subject.userId || subject.id || "").trim();
  if (!subjectRef) throw artifactError("artifact_owner_denied", "Artifact owner identity is required.", 403);
  const tenantRef = String(subject.tenantId || subject.tenantRef || "").trim();
  return createHash("sha256")
    .update("artifact-transit-owner\0")
    .update(subjectRef)
    .update("\0")
    .update(tenantRef)
    .digest("hex");
}

function safeName(value = "artifact.bin") {
  const name = path.basename(String(value || "artifact.bin").replace(/[\r\n\0]/gu, "")).slice(0, 255);
  return name || "artifact.bin";
}

function safeMediaType(value = "application/octet-stream") {
  const mediaType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function positiveLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_BYTES) {
    throw artifactError("artifact_limit_exceeded", "Artifact byte limit is invalid.");
  }
  return limit;
}

async function readMetadata(metadataPath) {
  try {
    const value = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function createArtifactTransitProvider({
  userDataPath,
  uploadSessionStore,
  getListenUrl = () => "",
  now = () => Date.now()
} = {}) {
  if (!String(userDataPath || "").trim()) throw new TypeError("Artifact transit requires userDataPath.");
  if (typeof uploadSessionStore?.resolveUploadSessionFiles !== "function") {
    throw new TypeError("Artifact transit requires the upload-session read port.");
  }
  const root = path.join(userDataPath, "artifact-transit");
  const pendingRoot = path.join(root, ".pending");
  await fsp.mkdir(pendingRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fsp.chmod(root, PRIVATE_DIRECTORY_MODE).catch(() => {});
  await fsp.chmod(pendingRoot, PRIVATE_DIRECTORY_MODE).catch(() => {});
  const active = new Map();

  const artifactDirectory = (id) => path.join(root, id);
  const contentPath = (id) => path.join(artifactDirectory(id), "content.bin");
  const metadataPath = (id) => path.join(artifactDirectory(id), "metadata.json");

  async function cleanupExpired() {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries.slice(0, 4096)) {
      if (!entry.isDirectory() || entry.name === ".pending" || !entry.name.startsWith("artifact_")) continue;
      const metadata = await readMetadata(metadataPath(entry.name));
      if (!metadata || Number(metadata.expiresAtMs || 0) <= now()) {
        await fsp.rm(artifactDirectory(entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    const pending = await fsp.readdir(pendingRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of pending.slice(0, 4096)) {
      if (!entry.isDirectory()) continue;
      const stat = await fsp.stat(path.join(pendingRoot, entry.name)).catch(() => null);
      if (stat && now() - stat.mtimeMs > 60 * 60 * 1000) {
        await fsp.rm(path.join(pendingRoot, entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  await cleanupExpired();

  async function resolve(reference, subject, purpose = "read") {
    const parsed = parseArtifactTransitReference(reference);
    if (parsed.kind === "upload") {
      const files = await uploadSessionStore.resolveUploadSessionFiles(userDataPath, parsed.id, { owner: subject });
      const file = files[parsed.fileIndex] || null;
      if (!file) throw artifactError("artifact_not_found", "Upload artifact is unavailable.", 404);
      return Object.freeze({
        reference: `upload:${parsed.id}:${parsed.fileIndex}`,
        kind: "upload",
        name: safeName(file.originalFileName || file.name),
        mediaType: safeMediaType(file.mediaType),
        byteLength: Number(file.byteSize || 0),
        sha256: String(file.sha256 || ""),
        purpose,
        expiresAt: ""
      });
    }
    const metadata = await readMetadata(metadataPath(parsed.id));
    if (!metadata || metadata.state !== "committed") {
      throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
    }
    if (metadata.ownerKey !== subjectKey(subject)) {
      throw artifactError("artifact_owner_denied", "Artifact is unavailable.", 404);
    }
    if (Number(metadata.expiresAtMs || 0) <= now()) {
      await fsp.rm(artifactDirectory(parsed.id), { recursive: true, force: true });
      throw artifactError("artifact_expired", "Artifact has expired.", 410);
    }
    const stat = await fsp.stat(contentPath(parsed.id)).catch(() => null);
    if (!stat || stat.size !== Number(metadata.byteLength || -1)) {
      throw artifactError("artifact_integrity_invalid", "Artifact integrity validation failed.", 409);
    }
    return Object.freeze({
      reference: `artifact:${parsed.id}`,
      kind: "artifact",
      name: safeName(metadata.name),
      mediaType: safeMediaType(metadata.mediaType),
      byteLength: Number(metadata.byteLength),
      sha256: String(metadata.sha256 || ""),
      purpose,
      expiresAt: String(metadata.expiresAt || ""),
      artifactId: parsed.id
    });
  }

  async function openRead(reference, subject, purpose = "read", range = null) {
    const metadata = await resolve(reference, subject, purpose);
    const parsed = parseArtifactTransitReference(reference);
    let sourcePath;
    if (parsed.kind === "upload") {
      const files = await uploadSessionStore.resolveUploadSessionFiles(userDataPath, parsed.id, { owner: subject });
      sourcePath = files[parsed.fileIndex]?.stagedPath || "";
    } else {
      sourcePath = contentPath(parsed.id);
    }
    if (!sourcePath) throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
    const start = Number.isSafeInteger(range?.start) ? range.start : undefined;
    const end = Number.isSafeInteger(range?.end) ? range.end : undefined;
    return Object.freeze({
      metadata,
      open: () => fs.createReadStream(sourcePath, {
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {})
      })
    });
  }

  async function beginWrite(subject, metadata = {}, policy = {}) {
    const id = `artifact_${randomUUID().replace(/-/gu, "")}`;
    const directory = path.join(pendingRoot, id);
    await fsp.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    const temporaryContentPath = path.join(directory, "content.bin");
    const writable = fs.createWriteStream(temporaryContentPath, {
      flags: "wx",
      mode: PRIVATE_FILE_MODE
    });
    const transaction = {
      id,
      directory,
      temporaryContentPath,
      writable,
      ownerKey: subjectKey(subject),
      name: safeName(metadata.name),
      mediaType: safeMediaType(metadata.mediaType),
      maxBytes: positiveLimit(policy.maxBytes),
      settled: false
    };
    active.set(id, transaction);
    return transaction;
  }

  async function abort(transaction, _reason = "artifact_write_aborted") {
    if (!transaction || transaction.settled) return;
    transaction.settled = true;
    active.delete(transaction.id);
    transaction.writable?.destroy?.();
    await fsp.rm(transaction.directory, { recursive: true, force: true });
  }

  async function commit(transaction, observed = {}) {
    if (!transaction || transaction.settled || !active.has(transaction.id)) {
      throw artifactError("artifact_commit_invalid", "Artifact transaction is unavailable.", 409);
    }
    const stat = await fsp.stat(transaction.temporaryContentPath);
    const byteLength = Number(observed.byteLength ?? stat.size);
    const sha256 = String(observed.sha256 || "").trim().toLowerCase();
    if (stat.size !== byteLength || byteLength > transaction.maxBytes || !/^[a-f0-9]{64}$/u.test(sha256)) {
      await abort(transaction, "artifact_integrity_invalid");
      throw artifactError("artifact_integrity_invalid", "Artifact integrity validation failed.", 409);
    }
    const createdAtMs = now();
    const expiresAtMs = createdAtMs + ARTIFACT_RETENTION_MS;
    const metadata = {
      schemaVersion: "v0.0.1:artifact-transit:metadata-1",
      state: "committed",
      artifactId: transaction.id,
      ownerKey: transaction.ownerKey,
      name: transaction.name,
      mediaType: transaction.mediaType,
      byteLength,
      sha256,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs
    };
    await fsp.writeFile(path.join(transaction.directory, "metadata.json"), JSON.stringify(metadata), {
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    const finalDirectory = artifactDirectory(transaction.id);
    await fsp.rename(transaction.directory, finalDirectory);
    transaction.settled = true;
    active.delete(transaction.id);
    const baseUrl = String(getListenUrl() || "").replace(/\/+$/u, "");
    const uri = baseUrl
      ? `${baseUrl}/api/gateway/v1/artifacts/${encodeURIComponent(transaction.id)}`
      : `licomesh://artifact/${transaction.id}`;
    return Object.freeze({
      reference: `artifact:${transaction.id}`,
      uri,
      name: transaction.name,
      mediaType: transaction.mediaType,
      byteLength,
      sha256,
      expiresAt: metadata.expiresAt
    });
  }

  async function close() {
    await Promise.all([...active.values()].map((transaction) => abort(transaction)));
    await cleanupExpired();
  }

  return assertArtifactTransitPort(Object.freeze({
    resolve,
    openRead,
    beginWrite,
    commit,
    abort,
    cleanupExpired,
    close
  }));
}
