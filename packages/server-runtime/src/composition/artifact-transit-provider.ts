import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  assertArtifactTransitPort,
  parseArtifactTransitReference
} from "#meshrix/foundation/storage/artifact-transit-port";

const ARTIFACT_RETENTION_MS: any = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES: any = 2 * 1024 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE: any = 0o700;
const PRIVATE_FILE_MODE: any = 0o600;

function artifactError(code?: any, message?: any, status: any = 400) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.reasonCode = code;
  error.status = status;
  return error;
}

function subjectKey(subject: Record<string, any> = {}) : any {
  const subjectRef: any = String(subject.subjectId || subject.userId || subject.id || "").trim();
  if (!subjectRef) throw artifactError("artifact_owner_denied", "Artifact owner identity is required.", 403);
  const tenantRef: any = String(subject.tenantId || subject.tenantRef || "").trim();
  return createHash("sha256")
    .update("artifact-transit-owner\0")
    .update(subjectRef)
    .update("\0")
    .update(tenantRef)
    .digest("hex");
}

function safeName(value: any = "artifact.bin") : any {
  const name: any = path.basename(String(value || "artifact.bin").replace(/[\r\n\0]/gu, "")).slice(0, 255);
  return name || "artifact.bin";
}

function safeMediaType(value: any = "application/octet-stream") : any {
  const mediaType: any = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function positiveLimit(value?: any) : any {
  const limit: any = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_BYTES) {
    throw artifactError("artifact_limit_exceeded", "Artifact byte limit is invalid.");
  }
  return limit;
}

export function createWorkspaceArtifactFileStore({ getAgentWorkspace }: Record<string, any> = {}) : any {
  return Object.freeze({
    resolveWorkspaceFile({ workspaceId, relativePath, owner, purpose }: Record<string, any> = {}) : any {
      const agentWorkspace: any = typeof getAgentWorkspace === "function" ? getAgentWorkspace() : null;
      if (typeof agentWorkspace?.openWorkspaceFileReadStream !== "function") {
        return { ok: false, status: 503, error: "Workspace artifact transit is unavailable." };
      }
      return agentWorkspace.openWorkspaceFileReadStream({
        workspaceId,
        path: relativePath,
        operationId: "upstream.artifact-transit",
        purpose,
        actorUserId: String(owner?.subjectId || owner?.userId || owner?.id || "").trim(),
        userId: String(owner?.userId || "").trim(),
        subjectId: String(owner?.subjectId || "").trim(),
        username: String(owner?.username || "").trim(),
        allowedWorkspaceIds: Array.isArray(owner?.allowedWorkspaceIds) ? owner.allowedWorkspaceIds : []
      });
    }
  });
}

async function readMetadata(metadataPath?: any) : Promise<any> {
  try {
    const value: any = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function createArtifactTransitProvider({
  userDataPath,
  uploadSessionStore,
  uploadCustodyReadPort,
  workspaceFileStore = null,
  getListenUrl = () : any => "",
  now = () : any => Date.now()
}: Record<string, any> = {}) : Promise<any> {
  if (!String(userDataPath || "").trim()) throw new TypeError("Artifact transit requires userDataPath.");
  if (typeof uploadSessionStore?.resolveUploadSessionFiles !== "function") {
    throw new TypeError("Artifact transit requires the upload-session read port.");
  }
  if (typeof uploadCustodyReadPort?.open !== "function") {
    throw new TypeError("Artifact transit requires the upload-custody read port.");
  }
  const root: any = path.join(userDataPath, "artifact-transit");
  const pendingRoot: any = path.join(root, ".pending");
  await fsp.mkdir(pendingRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fsp.chmod(root, PRIVATE_DIRECTORY_MODE).catch(() : any => {});
  await fsp.chmod(pendingRoot, PRIVATE_DIRECTORY_MODE).catch(() : any => {});
  const active: any = new Map<any, any>();

  const artifactDirectory: any = (id?: any) : any => path.join(root, id);
  const contentPath: any = (id?: any) : any => path.join(artifactDirectory(id), "content.bin");
  const metadataPath: any = (id?: any) : any => path.join(artifactDirectory(id), "metadata.json");

  async function cleanupExpired() : Promise<any> {
    const entries: any = await fsp.readdir(root, { withFileTypes: true }).catch(() : any => []);
    let removed: any = 0;
    for (const entry of entries.slice(0, 4096)) {
      if (!entry.isDirectory() || entry.name === ".pending" || !entry.name.startsWith("artifact_")) continue;
      const metadata: any = await readMetadata(metadataPath(entry.name));
      if (!metadata || Number(metadata.expiresAtMs || 0) <= now()) {
        await fsp.rm(artifactDirectory(entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    const pending: any = await fsp.readdir(pendingRoot, { withFileTypes: true }).catch(() : any => []);
    for (const entry of pending.slice(0, 4096)) {
      if (!entry.isDirectory()) continue;
      const stat: any = await fsp.stat(path.join(pendingRoot, entry.name)).catch(() : any => null);
      if (stat && now() - stat.mtimeMs > 60 * 60 * 1000) {
        await fsp.rm(path.join(pendingRoot, entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  await cleanupExpired();

  async function readWorkspaceFile(parsed?: any, subject?: any, purpose?: any) : Promise<any> {
    if (typeof workspaceFileStore?.resolveWorkspaceFile !== "function") {
      throw artifactError("artifact_workspace_unavailable", "Workspace artifact transit is unavailable.", 503);
    }
    const file: any = await workspaceFileStore.resolveWorkspaceFile({
      workspaceId: parsed.id,
      relativePath: parsed.path,
      owner: subject,
      purpose
    });
    if (!file || file.ok !== true) {
      const status: any = Number(file?.status || 404);
      if (status === 400) throw artifactError("artifact_reference_invalid", "Artifact reference is invalid.", 400);
      if (status === 403) throw artifactError("artifact_owner_denied", "Artifact is unavailable.", 404);
      if (status === 503) throw artifactError("artifact_workspace_unavailable", "Workspace artifact transit is unavailable.", 503);
      throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
    }
    return file;
  }

  function workspaceMetadata(parsed?: any, file?: any, purpose?: any) : any {
    return Object.freeze({
      reference: `workspace:${parsed.id}:${parsed.path}`,
      kind: "workspace",
      name: safeName(file.name),
      mediaType: safeMediaType(file.mediaType),
      byteLength: Number(file.byteLength || 0),
      sha256: String(file.sha256 || ""),
      purpose,
      expiresAt: ""
    });
  }

  async function resolve(reference?: any, subject?: any, purpose: any = "read") : Promise<any> {
    const parsed: any = parseArtifactTransitReference(reference);
    if (parsed.kind === "workspace") {
      const file: any = await readWorkspaceFile(parsed, subject, purpose);
      return workspaceMetadata(parsed, file, purpose);
    }
    if (parsed.kind === "upload") {
      const files: any = await uploadSessionStore.resolveUploadSessionFiles(parsed.id, { owner: subject });
      const file: any = files[parsed.fileIndex] || null;
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
    const metadata: any = await readMetadata(metadataPath(parsed.id));
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
    const stat: any = await fsp.stat(contentPath(parsed.id)).catch(() : any => null);
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

  async function openRead(reference?: any, subject?: any, purpose: any = "read", range: any = null, access: Record<string, any> = {}) : Promise<any> {
    const parsed: any = parseArtifactTransitReference(reference);
    const start: any = Number.isSafeInteger(range?.start) ? range.start : undefined;
    const end: any = Number.isSafeInteger(range?.end) ? range.end : undefined;
    if (parsed.kind === "workspace") {
      const file: any = await readWorkspaceFile(parsed, subject, purpose);
      if (typeof file.open !== "function") throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
      return Object.freeze({
        metadata: workspaceMetadata(parsed, file, purpose),
        open: () : any => file.open({ start, end })
      });
    }
    const metadata: any = await resolve(reference, subject, purpose);
    if (parsed.kind === "upload") {
      const files: any = await uploadSessionStore.resolveUploadSessionFiles(parsed.id, { owner: subject });
      const file: any = files[parsed.fileIndex] || null;
      if (!file) throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
      const opened: any = await uploadCustodyReadPort.open({
        custodyRef: file.custodyRef,
        contentDigest: file.contentDigest || file.sha256,
        envelopeDigest: file.envelopeDigest,
        byteCount: file.byteSize,
        owner: subject,
        resourceRef: file.resourceRef,
        governedExecutionReceipt: access.governedExecutionReceipt || null,
        maxBytes: file.byteSize,
        signal: access.signal || null
      });
      return Object.freeze({
        metadata,
        open: () : any => opened.stream
      });
    }
    const sourcePath: any = contentPath(parsed.id);
    if (!sourcePath) throw artifactError("artifact_not_found", "Artifact is unavailable.", 404);
    return Object.freeze({
      metadata,
      open: () : any => fs.createReadStream(sourcePath, {
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {})
      })
    });
  }

  async function beginWrite(subject?: any, metadata: Record<string, any> = {}, policy: Record<string, any> = {}) : Promise<any> {
    const id: any = `artifact_${randomUUID().replace(/-/gu, "")}`;
    const directory: any = path.join(pendingRoot, id);
    await fsp.mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    const temporaryContentPath: any = path.join(directory, "content.bin");
    const writable: any = fs.createWriteStream(temporaryContentPath, {
      flags: "wx",
      mode: PRIVATE_FILE_MODE
    });
    const transaction: Record<string, any> = {
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

  async function abort(transaction?: any, _reason: any = "artifact_write_aborted") : Promise<any> {
    if (!transaction || transaction.settled) return;
    transaction.settled = true;
    active.delete(transaction.id);
    transaction.writable?.destroy?.();
    await fsp.rm(transaction.directory, { recursive: true, force: true });
  }

  async function commit(transaction?: any, observed: Record<string, any> = {}) : Promise<any> {
    if (!transaction || transaction.settled || !active.has(transaction.id)) {
      throw artifactError("artifact_commit_invalid", "Artifact transaction is unavailable.", 409);
    }
    const stat: any = await fsp.stat(transaction.temporaryContentPath);
    const byteLength: any = Number(observed.byteLength ?? stat.size);
    const sha256: any = String(observed.sha256 || "").trim().toLowerCase();
    if (stat.size !== byteLength || byteLength > transaction.maxBytes || !/^[a-f0-9]{64}$/u.test(sha256)) {
      await abort(transaction, "artifact_integrity_invalid");
      throw artifactError("artifact_integrity_invalid", "Artifact integrity validation failed.", 409);
    }
    const createdAtMs: any = now();
    const expiresAtMs: any = createdAtMs + ARTIFACT_RETENTION_MS;
    const metadata: Record<string, any> = {
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
    const finalDirectory: any = artifactDirectory(transaction.id);
    await fsp.rename(transaction.directory, finalDirectory);
    transaction.settled = true;
    active.delete(transaction.id);
    const baseUrl: any = String(getListenUrl() || "").replace(/\/+$/u, "");
    const uri: any = baseUrl
      ? `${baseUrl}/api/gateway/v1/artifacts/${encodeURIComponent(transaction.id)}`
      : `meshrix://artifact/${transaction.id}`;
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

  async function close() : Promise<any> {
    await Promise.all([...active.values()].map((transaction?: any) : any => abort(transaction)));
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
