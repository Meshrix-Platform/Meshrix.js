import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

import {
  SANDBOX_CUSTODY_ENVELOPE_SCHEMA,
  normalizeCustodyHandle,
  normalizeCustodyPromotionRequest
} from "#lico/foundation/execution-sandbox/custody-contracts";
import { sandboxDigest } from "#lico/foundation/execution-sandbox/contracts";

const CHUNK_BYTES = 64 * 1024;
const MAX_CUSTODY_BYTES = 256 * 1024 * 1024;
const CONTENT_ALGORITHM = "aes-256-gcm";
const SEAL_REQUEST_SCHEMA = "v0.0.1:execution-sandbox:opaque-custody-seal-request-1";

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeDigest(left, right) {
  if (!/^[a-f0-9]{64}$/u.test(String(left)) || !/^[a-f0-9]{64}$/u.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function chunkAad(headerDigest, index, plaintextBytes, previousFrameDigest) {
  return Buffer.from(`${headerDigest}\0${index}\0${plaintextBytes}\0${previousFrameDigest}`, "utf8");
}

function nonceFor(prefixBase64, index) {
  const prefix = Buffer.from(String(prefixBase64 || ""), "base64");
  if (prefix.length !== 8 || !Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw fail("custody_envelope_invalid", "Custody envelope nonce state is invalid.");
  }
  const nonce = Buffer.allocUnsafe(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

function headerBinding(header) {
  return {
    type: "header",
    schemaVersion: header.schemaVersion,
    envelopeId: header.envelopeId,
    algorithm: header.algorithm,
    mediaType: header.mediaType,
    noncePrefix: header.noncePrefix,
    wrappedKey: header.wrappedKey
  };
}

function frameDigest(record) {
  return hashHex(Buffer.from(JSON.stringify(record), "utf8"));
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

async function writeLine(stream, value) {
  if (!stream.write(line(value), "utf8")) await once(stream, "drain");
}

async function *boundedChunks(source, maxBytes) {
  let total = 0;
  for await (const input of source) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || "");
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES));
      total += chunk.length;
      if (total > maxBytes) throw fail("custody_size_exceeded", "Custody input exceeds its byte budget.");
      yield chunk;
    }
  }
}

function safeMediaType(value) {
  const normalized = String(value || "application/octet-stream").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u.test(normalized)) {
    throw new TypeError("Custody mediaType is invalid.");
  }
  return normalized;
}

async function parseEnvelope(filePath, onChunk) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let footer = null;
  let index = 0;
  try {
    for await (const raw of lines) {
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); } catch (error) {
        throw fail("custody_envelope_invalid", "Custody envelope is malformed.", error);
      }
      if (!header) {
        if (record?.type !== "header" || record.schemaVersion !== SANDBOX_CUSTODY_ENVELOPE_SCHEMA) {
          throw fail("custody_envelope_invalid", "Custody envelope header is invalid.");
        }
        header = record;
        continue;
      }
      if (record?.type === "footer") {
        if (footer) throw fail("custody_envelope_invalid", "Custody envelope contains duplicate footer state.");
        footer = record;
        continue;
      }
      if (footer || record?.type !== "chunk" || record.index !== index) {
        throw fail("custody_envelope_invalid", "Custody envelope chunk sequence is invalid.");
      }
      await onChunk(record, header, index);
      index += 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!header || !footer || footer.chunkCount !== index) {
    throw fail("custody_envelope_invalid", "Custody envelope is incomplete.");
  }
  return { header, footer };
}

export function createOpaqueSandboxCustodyRuntime({ userDataPath, storageKernel, storageProvider, keyBroker } = {}) {
  if (!storageProvider?.putObjectsFromFiles || !storageProvider?.getObject || !storageProvider?.resolveStoredObjectPath) {
    throw new TypeError("Opaque sandbox custody requires the core storage provider.");
  }
  if (!keyBroker?.wrapKey || !keyBroker?.unwrapKey) {
    throw new TypeError("Opaque sandbox custody requires a custody key broker.");
  }
  if (!storageKernel?.db) throw new TypeError("Opaque sandbox custody requires the core storage kernel.");
  const db = storageKernel.db;
  const pendingRoot = path.join(path.resolve(String(userDataPath || "")), "execution-sandbox-custody", "pending");

  async function store({
    source,
    mediaType,
    maxBytes = MAX_CUSTODY_BYTES,
    idempotencyKey,
    ownerBinding = {}
  } = {}) {
    if (!source || typeof source[Symbol.asyncIterator] !== "function") {
      throw new TypeError("Custody source must be an async iterable.");
    }
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CUSTODY_BYTES) {
      throw new TypeError("Custody maxBytes is invalid.");
    }
    const sealKey = String(idempotencyKey || "").trim();
    const subjectRef = String(ownerBinding.subjectRef || "").trim();
    const tenantRef = String(ownerBinding.tenantRef || "").trim();
    const workspaceRef = String(ownerBinding.workspaceRef || "").trim();
    if (!sealKey || !subjectRef || !tenantRef || !workspaceRef) {
      throw new TypeError("Custody seal requires idempotency and complete owner binding.");
    }
    const normalizedMediaType = safeMediaType(mediaType);
    const sealRequestDigest = sandboxDigest({
      schemaVersion: SEAL_REQUEST_SCHEMA,
      mediaType: normalizedMediaType,
      maxBytes: limit,
      ownerBinding: { subjectRef, tenantRef, workspaceRef }
    });
    const existing = db.prepare(`
      SELECT custody_ref, seal_request_digest, content_digest, envelope_digest,
             plaintext_bytes, chunk_count, media_type, owner_subject_ref,
             tenant_ref, workspace_ref, state
      FROM opaque_custody_artifacts WHERE seal_idempotency_key = ? LIMIT 1
    `).get(sealKey);
    if (existing) {
      if (
        existing.seal_request_digest !== sealRequestDigest ||
        existing.media_type !== normalizedMediaType ||
        existing.owner_subject_ref !== subjectRef ||
        existing.tenant_ref !== tenantRef ||
        existing.workspace_ref !== workspaceRef
      ) {
        throw fail(
          "custody_seal_idempotency_conflict",
          "Custody seal idempotency binding conflicts."
        );
      }
      return Object.freeze({
        handle: existing.custody_ref,
        envelopeDigest: existing.envelope_digest,
        contentDigest: existing.content_digest,
        byteCount: Number(existing.plaintext_bytes),
        chunkCount: Number(existing.chunk_count),
        state: existing.state === "sealed" ? "stored_no_run" : existing.state,
        replayed: true
      });
    }
    await fsp.mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    await fsp.chmod(pendingRoot, 0o700);
    const envelopeId = `env_${crypto.randomUUID()}`;
    const objectId = `custody_${crypto.randomUUID()}`;
    const temporaryPath = path.join(pendingRoot, `${objectId}.pending`);
    const dataKey = crypto.randomBytes(32);
    const wrappedKey = await keyBroker.wrapKey(dataKey, envelopeId);
    const stream = fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
    const contentHash = crypto.createHash("sha256");
    let byteCount = 0;
    let chunkCount = 0;
    try {
      const headerBase = {
        type: "header",
        schemaVersion: SANDBOX_CUSTODY_ENVELOPE_SCHEMA,
        envelopeId,
        algorithm: CONTENT_ALGORITHM,
        mediaType: normalizedMediaType,
        noncePrefix: crypto.randomBytes(8).toString("base64"),
        wrappedKey
      };
      const headerDigest = hashHex(Buffer.from(JSON.stringify(headerBase), "utf8"));
      await writeLine(stream, { ...headerBase, headerDigest });
      let previousFrameDigest = "0".repeat(64);
      for await (const chunk of boundedChunks(source, limit)) {
        const nonce = nonceFor(headerBase.noncePrefix, chunkCount);
        const cipher = crypto.createCipheriv(CONTENT_ALGORITHM, dataKey, nonce);
        cipher.setAAD(chunkAad(headerDigest, chunkCount, chunk.length, previousFrameDigest));
        const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final()]);
        const frame = {
          type: "chunk",
          index: chunkCount,
          plaintextBytes: chunk.length,
          previousFrameDigest,
          ciphertext: ciphertext.toString("base64"),
          tag: cipher.getAuthTag().toString("base64")
        };
        await writeLine(stream, frame);
        previousFrameDigest = frameDigest(frame);
        contentHash.update(chunk);
        byteCount += chunk.length;
        chunkCount += 1;
      }
      const footerPayload = {
        type: "footer",
        contentDigest: contentHash.digest("hex"),
        byteCount,
        chunkCount,
        finalFrameDigest: previousFrameDigest,
        mediaTypeDigest: hashHex(Buffer.from(headerBase.mediaType, "utf8"))
      };
      const footerMac = crypto.createHmac("sha256", dataKey).update(JSON.stringify(footerPayload)).digest("hex");
      await writeLine(stream, { ...footerPayload, footerMac });
      stream.end();
      await once(stream, "close");
      const [stored] = await storageProvider.putObjectsFromFiles([{
        sourcePath: temporaryPath,
        namespace: "execution-sandbox-custody",
        fileName: "opaque-envelope.custody",
        mediaType: "application/vnd.licomesh.opaque-custody",
        objectId,
        metadata: {
          ownerSubjectId: subjectRef
        }
      }]);
      const custodyRef = `custody:${stored.objectId}`;
      const timestamp = new Date().toISOString();
      try {
        db.prepare(`
          INSERT INTO opaque_custody_artifacts (
            custody_ref, object_id, seal_idempotency_key, seal_request_digest,
            content_digest, envelope_digest,
            plaintext_bytes, ciphertext_bytes, chunk_count, media_type, owner_subject_ref,
            tenant_ref, workspace_ref, key_ref, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?)
        `).run(
          custodyRef,
          stored.objectId,
          sealKey,
          sealRequestDigest,
          footerPayload.contentDigest,
          stored.sha256,
          byteCount,
          stored.byteSize,
          chunkCount,
          normalizedMediaType,
          subjectRef,
          tenantRef,
          workspaceRef,
          wrappedKey.keyReference,
          timestamp,
          timestamp
        );
      } catch (error) {
        db.prepare("DELETE FROM storage_objects WHERE object_id = ?").run(stored.objectId);
        await fsp.rm(storageProvider.resolveStoredObjectPath(stored.storageRelativePath), { force: true }).catch(() => {});
        throw error;
      }
      return Object.freeze({
        handle: custodyRef,
        envelopeDigest: stored.sha256,
        contentDigest: footerPayload.contentDigest,
        byteCount,
        chunkCount,
        state: "stored_no_run"
      });
    } finally {
      dataKey.fill(0);
      stream.destroy();
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  function objectForHandle(handle) {
    const normalized = normalizeCustodyHandle(handle);
    const row = db.prepare(`
      SELECT custody.custody_ref, custody.content_digest, custody.envelope_digest,
             custody.plaintext_bytes, custody.ciphertext_bytes, custody.chunk_count,
             custody.media_type, custody.owner_subject_ref, custody.tenant_ref,
             custody.workspace_ref, custody.key_ref, custody.state,
             objects.object_id, objects.namespace, objects.storage_rel_path
      FROM opaque_custody_artifacts AS custody
      JOIN storage_objects AS objects ON objects.object_id = custody.object_id
      WHERE custody.custody_ref = ? LIMIT 1
    `).get(normalized);
    if (!row || row.namespace !== "execution-sandbox-custody" || row.state !== "sealed") {
      throw fail("custody_object_missing", "Opaque custody object is unavailable.");
    }
    return row;
  }

  function status(handle) {
    const normalized = normalizeCustodyHandle(handle);
    const object = db.prepare(`
      SELECT custody_ref, content_digest, envelope_digest, plaintext_bytes, chunk_count, state
      FROM opaque_custody_artifacts WHERE custody_ref = ? LIMIT 1
    `).get(normalized);
    if (!object) throw fail("custody_object_missing", "Opaque custody object is unavailable.");
    return Object.freeze({
      handle: normalized,
      envelopeDigest: object.envelope_digest,
      contentDigest: object.content_digest,
      byteCount: Number(object.plaintext_bytes),
      chunkCount: Number(object.chunk_count),
      state: object.state === "sealed" ? "stored_no_run" : object.state
    });
  }

  function describe(handle, ownerBinding = {}) {
    const object = objectForHandle(handle);
    if (
      object.owner_subject_ref !== String(ownerBinding.subjectRef || "").trim() ||
      object.tenant_ref !== String(ownerBinding.tenantRef || "").trim() ||
      object.workspace_ref !== String(ownerBinding.workspaceRef || "").trim()
    ) {
      throw fail("custody_describe_owner_mismatch", "Custody description owner binding failed.");
    }
    return status(handle);
  }

  function downloadEnvelope(handle, ownerBinding = {}) {
    const object = objectForHandle(handle);
    if (
      object.owner_subject_ref !== String(ownerBinding.subjectRef || "").trim() ||
      object.tenant_ref !== String(ownerBinding.tenantRef || "").trim() ||
      object.workspace_ref !== String(ownerBinding.workspaceRef || "").trim()
    ) {
      throw fail("custody_download_owner_mismatch", "Custody download owner binding failed.");
    }
    return fs.createReadStream(storageProvider.resolveStoredObjectPath(object.storage_rel_path));
  }

  async function deleteArtifact({ handle, ownerBinding = {}, authorizationRef = "" } = {}) {
    const object = objectForHandle(handle);
    if (!String(authorizationRef || "").trim()) {
      throw fail("custody_delete_authorization_missing", "Custody deletion requires authorization.");
    }
    if (
      object.owner_subject_ref !== String(ownerBinding.subjectRef || "").trim() ||
      object.tenant_ref !== String(ownerBinding.tenantRef || "").trim() ||
      object.workspace_ref !== String(ownerBinding.workspaceRef || "").trim()
    ) {
      throw fail("custody_delete_owner_mismatch", "Custody deletion owner binding failed.");
    }
    const objectPath = storageProvider.resolveStoredObjectPath(object.storage_rel_path);
    const remove = db.transaction(() => {
      db.prepare(`
        UPDATE opaque_custody_artifacts
        SET state = 'deleted', object_id = NULL, updated_at = ?
        WHERE custody_ref = ? AND state = 'sealed'
      `).run(new Date().toISOString(), object.custody_ref);
      db.prepare("DELETE FROM storage_objects WHERE object_id = ?").run(object.object_id);
    });
    remove();
    await fsp.rm(objectPath, { force: true });
    return Object.freeze({ handle: object.custody_ref, state: "deleted" });
  }

  async function promote(request, sink) {
    if (typeof sink !== "function") throw new TypeError("Custody promotion requires a plaintext sink.");
    const promotion = normalizeCustodyPromotionRequest(request);
    const object = objectForHandle(promotion.handle);
    if (
      object.owner_subject_ref !== promotion.subjectRef ||
      object.tenant_ref !== promotion.tenantRef ||
      object.workspace_ref !== promotion.workspaceRef
    ) {
      throw fail("custody_promotion_owner_mismatch", "Custody promotion owner binding failed.");
    }
    if (!timingSafeDigest(object.envelope_digest, promotion.envelopeDigest) ||
        !timingSafeDigest(object.content_digest, promotion.contentDigest)) {
      throw fail("custody_promotion_digest_mismatch", "Custody promotion digest binding failed.");
    }
    const requestDigest = sandboxDigest(promotion);
    const existingPromotion = db.prepare(`
      SELECT promotion_id, request_digest, state
      FROM opaque_custody_promotions
      WHERE idempotency_key = ?
      LIMIT 1
    `).get(promotion.idempotencyKey);
    let replayingReleasedPromotion = false;
    let retryingFailedPromotion = false;
    if (existingPromotion) {
      if (existingPromotion.request_digest !== requestDigest) {
        throw fail("custody_promotion_idempotency_conflict", "Custody promotion idempotency binding conflicts.");
      }
      if (existingPromotion.state === "released") {
        replayingReleasedPromotion = true;
      } else if (existingPromotion.state === "failed") {
        retryingFailedPromotion = true;
      } else {
        throw fail("custody_promotion_replay_unavailable", "Custody promotion replay is not available for this state.");
      }
    }
    const promotionId = existingPromotion?.promotion_id || `promotion_${crypto.randomUUID()}`;
    if (!existingPromotion) {
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO opaque_custody_promotions (
          promotion_id, custody_ref, idempotency_key, request_digest, state,
          provider_receipt_digest, reason_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'validating', ?, '', ?, ?)
      `).run(
        promotionId,
        promotion.handle,
        promotion.idempotencyKey,
        requestDigest,
        promotion.providerReceipt.digest,
        timestamp,
        timestamp
      );
    } else if (retryingFailedPromotion) {
      db.prepare(`
        UPDATE opaque_custody_promotions
        SET state = 'validating', reason_code = '', updated_at = ?
        WHERE promotion_id = ?
      `).run(new Date().toISOString(), promotionId);
    }
    const filePath = storageProvider.resolveStoredObjectPath(object.storage_rel_path);
    let dataKey = null;
    let verifiedFooter = null;
    try {
      let validationFrameDigest = "0".repeat(64);
      const validation = await parseEnvelope(filePath, async (record, header, index) => {
        const computedHeaderDigest = hashHex(Buffer.from(JSON.stringify(headerBinding(header)), "utf8"));
        if (
          header.algorithm !== CONTENT_ALGORITHM ||
          !timingSafeDigest(computedHeaderDigest, header.headerDigest) ||
          record.previousFrameDigest !== validationFrameDigest ||
          !Number.isSafeInteger(record.plaintextBytes) ||
          record.plaintextBytes < 0 ||
          record.plaintextBytes > CHUNK_BYTES
        ) throw fail("custody_envelope_invalid", "Custody envelope binding is invalid.");
        dataKey ||= await keyBroker.unwrapKey(header.wrappedKey, header.envelopeId);
        const decipher = crypto.createDecipheriv(CONTENT_ALGORITHM, dataKey, nonceFor(header.noncePrefix, index));
        decipher.setAAD(chunkAad(header.headerDigest, index, record.plaintextBytes, validationFrameDigest));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
        if (plaintext.length !== record.plaintextBytes) {
          plaintext.fill(0);
          throw fail("custody_envelope_invalid", "Custody envelope chunk length is invalid.");
        }
        plaintext.fill(0);
        validationFrameDigest = frameDigest(record);
      });
      const validationHeaderDigest = hashHex(Buffer.from(JSON.stringify(headerBinding(validation.header)), "utf8"));
      if (
        validation.header.algorithm !== CONTENT_ALGORITHM ||
        !timingSafeDigest(validationHeaderDigest, validation.header.headerDigest)
      ) throw fail("custody_envelope_invalid", "Custody envelope header binding is invalid.");
      dataKey ||= await keyBroker.unwrapKey(validation.header.wrappedKey, validation.header.envelopeId);
      const footerPayload = {
        type: "footer",
        contentDigest: validation.footer.contentDigest,
        byteCount: validation.footer.byteCount,
        chunkCount: validation.footer.chunkCount,
        finalFrameDigest: validation.footer.finalFrameDigest,
        mediaTypeDigest: validation.footer.mediaTypeDigest
      };
      const expectedMac = crypto.createHmac("sha256", dataKey).update(JSON.stringify(footerPayload)).digest("hex");
      if (!timingSafeDigest(expectedMac, validation.footer.footerMac) ||
          !timingSafeDigest(footerPayload.contentDigest, promotion.contentDigest) ||
          !timingSafeDigest(footerPayload.finalFrameDigest, validationFrameDigest) ||
          !timingSafeDigest(footerPayload.mediaTypeDigest, hashHex(Buffer.from(validation.header.mediaType, "utf8")))) {
        throw fail("custody_envelope_authentication_failed", "Custody envelope authentication failed.");
      }
      verifiedFooter = footerPayload;
      const contentHash = crypto.createHash("sha256");
      let byteCount = 0;
      let releaseFrameDigest = "0".repeat(64);
      const release = await parseEnvelope(filePath, async (record, header, index) => {
        if (record.previousFrameDigest !== releaseFrameDigest) {
          throw fail("custody_envelope_invalid", "Custody envelope chunk chain is invalid.");
        }
        const decipher = crypto.createDecipheriv(CONTENT_ALGORITHM, dataKey, nonceFor(header.noncePrefix, index));
        decipher.setAAD(chunkAad(header.headerDigest, index, record.plaintextBytes, releaseFrameDigest));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
        if (plaintext.length !== record.plaintextBytes) {
          plaintext.fill(0);
          throw fail("custody_envelope_invalid", "Custody envelope chunk length is invalid.");
        }
        contentHash.update(plaintext);
        byteCount += plaintext.length;
        try { await sink(plaintext); } finally { plaintext.fill(0); }
        releaseFrameDigest = frameDigest(record);
      });
      if (release.footer.chunkCount !== verifiedFooter.chunkCount || byteCount !== verifiedFooter.byteCount ||
          !timingSafeDigest(releaseFrameDigest, verifiedFooter.finalFrameDigest) ||
          !timingSafeDigest(contentHash.digest("hex"), verifiedFooter.contentDigest)) {
        throw fail("custody_envelope_authentication_failed", "Custody envelope content verification failed.");
      }
      db.prepare(`
        UPDATE opaque_custody_promotions SET state = 'released', updated_at = ? WHERE promotion_id = ?
      `).run(new Date().toISOString(), promotionId);
      return Object.freeze({
        handle: promotion.handle,
        contentDigest: promotion.contentDigest,
        envelopeDigest: promotion.envelopeDigest,
        byteCount,
        promotionState: replayingReleasedPromotion
          ? "replayed_release_to_sandbox_input"
          : "released_to_sandbox_input",
        providerReceiptDigest: promotion.providerReceipt.digest
      });
    } catch (error) {
      const exposedError = [
        "custody_key_unwrap_failed",
        "custody_key_reference_invalid",
        "custody_envelope_invalid"
      ].includes(error?.code)
        ? fail("custody_envelope_authentication_failed", "Custody envelope authentication failed.", error)
        : error;
      if (!replayingReleasedPromotion) {
        db.prepare(`
          UPDATE opaque_custody_promotions
          SET state = 'failed', reason_code = ?, updated_at = ?
          WHERE promotion_id = ?
        `).run(String(exposedError?.code || "custody_promotion_failed"), new Date().toISOString(), promotionId);
      }
      if (exposedError?.code) throw exposedError;
      throw fail("custody_envelope_authentication_failed", "Custody envelope authentication failed.", exposedError);
    } finally {
      dataKey?.fill(0);
    }
  }

  const custody = Object.freeze({ store, status, describe, downloadEnvelope, delete: deleteArtifact });
  const promotionAuthority = Object.freeze({ promote });
  return Object.freeze({ custody, promotionAuthority });
}

export function createOpaqueSandboxCustody(options = {}) {
  return createOpaqueSandboxCustodyRuntime(options).custody;
}
