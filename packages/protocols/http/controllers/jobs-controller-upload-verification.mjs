import { createHash } from "node:crypto";
import path from "node:path";
import { hashClientString, serverToken } from "#meshrix/client-strings";

const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_MAX_CONTAINER_SCAN_ENTRIES = 512;
const ZIP_MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024;

function bufferStartsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length < 0.02;
}

function inferZipExtension(buffer) {
  const names = zipCentralDirectoryEntryNames(buffer).join("\n");
  if (names.includes("ppt/")) {
    return ".pptx";
  }
  if (names.includes("word/")) {
    return ".docx";
  }
  return names.includes("xl/") ? ".xlsx" : ".zip";
}

function findZipEndOfCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES) {
    return -1;
  }
  const start = Math.max(0, buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let index = buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return index;
    }
  }
  return -1;
}

function zipCentralDirectoryEntryNames(buffer) {
  const endOffset = findZipEndOfCentralDirectory(buffer);
  if (endOffset < 0 || endOffset + ZIP_END_OF_CENTRAL_DIRECTORY_MIN_BYTES > buffer.length) {
    return [];
  }
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    entryCount === 0 ||
    entryCount > ZIP_MAX_CONTAINER_SCAN_ENTRIES ||
    directorySize > ZIP_MAX_CENTRAL_DIRECTORY_BYTES ||
    directoryOffset + directorySize > buffer.length ||
    directoryOffset >= endOffset
  ) {
    return [];
  }

  const names = [];
  let offset = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  for (let index = 0; index < entryCount && offset < directoryEnd; index += 1) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      return [];
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nameLength <= 0 || nameEnd > directoryEnd || nextOffset > directoryEnd) {
      return [];
    }
    names.push(buffer.subarray(nameStart, nameEnd).toString("utf8").replace(/\\/g, "/").toLowerCase());
    offset = nextOffset;
  }
  return names;
}

function inferUploadedExtension(buffer) {
  if (bufferStartsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return ".pdf";
  }
  if (bufferStartsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) {
    return ".png";
  }
  if (bufferStartsWith(buffer, [0xff, 0xd8, 0xff])) {
    return ".jpg";
  }
  if (bufferStartsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return ".gif";
  }
  if (bufferStartsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return inferZipExtension(buffer);
  }
  if (looksLikeText(buffer)) {
    const text = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8");
    if (/^(from|subject|date|message-id|mime-version|content-type):/im.test(text)) {
      return ".eml";
    }
    if (/^\s*(<!doctype\s+html|<html|<head|<body)\b/i.test(text)) {
      return ".html";
    }
    if (/^\s*(def|class|import|from)\s+[A-Za-z_]/m.test(text)) {
      return ".py";
    }
    return ".txt";
  }
  return "";
}

export function defaultArchiveBatchResolver(input = {}) {
  return {
    archiveBatchId: String(input.archiveBatchId || input.clientBatchId || input.batchId || input.checkpointId || input.manifestDigest || "").trim()
  };
}

export function verifyUploadedFiles(payload = {}, { resolveArchiveBatchIdentity = defaultArchiveBatchResolver } = {}) {
  const uploadedFiles = Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles : [];
  const clientUid = String(payload?.clientUid || payload?.clientId || payload?.checkpoint?.clientUid || payload?.checkpoint?.clientId || "").trim();
  const sourceType = String(payload?.sourceType || payload?.resourceType || payload?.checkpoint?.sourceType || payload?.checkpoint?.resourceType || "upload").trim();
  const providerId = String(payload?.providerId || payload?.checkpoint?.providerId || "").trim();
  const externalId = String(payload?.externalId || payload?.checkpoint?.externalId || "").trim();
  const syncBatchId = String(payload?.syncBatchId || payload?.checkpoint?.syncBatchId || "").trim();
  const contentHash = String(payload?.contentHash || payload?.checkpoint?.contentHash || "").trim();
  const capturedAt = String(payload?.capturedAt || payload?.checkpoint?.capturedAt || "").trim();
  const verifiedFiles = uploadedFiles.map((file, index) => {
    const dataBase64 = String(file?.dataBase64 || "");
    const buffer = Buffer.from(dataBase64, "base64");
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const byteSize = buffer.length;
    const claimedSha256 = String(file?.sha256 || "").trim().toLowerCase();
    const claimedByteSize = Number(file?.byteSize || 0);

    if (claimedSha256 && claimedSha256 !== sha256) {
      throw new Error(`文件哈希校验失败：文件#${index + 1}`);
    }

    if (claimedByteSize > 0 && claimedByteSize !== byteSize) {
      throw new Error(`文件大小校验失败：文件#${index + 1}`);
    }

    const sourceName = String(file?.name || "");
    const sourceRelativePath = String(file?.relativePath || sourceName || `upload-${index + 1}`);
    const originalFileName = path.posix.basename(sourceRelativePath || sourceName || `upload-${index + 1}`);
    const sourceNameHash = hashClientString(sourceName, "meshrix_upload.name");
    const sourceRelativePathHash = hashClientString(sourceRelativePath, "meshrix_upload.relative_path");
    const extension = inferUploadedExtension(buffer);
    const fileToken = serverToken(
      "upload_file",
      "meshrix",
      index,
      sourceRelativePathHash,
      sha256,
      byteSize
    );
    const safeTokenName = `${fileToken}${extension}`;
    return {
      name: safeTokenName,
      relativePath: safeTokenName,
      originalFileName,
      clientUid: String(file?.clientUid || file?.clientId || clientUid || "").trim(),
      sourceType: String(file?.sourceType || file?.resourceType || sourceType || "upload").trim(),
      providerId: String(file?.providerId || providerId || "").trim(),
      externalId: String(file?.externalId || externalId || "").trim(),
      syncBatchId: String(file?.syncBatchId || syncBatchId || "").trim(),
      contentHash: String(file?.contentHash || contentHash || sha256 || "").trim(),
      capturedAt: String(file?.capturedAt || capturedAt || "").trim(),
      sourceMetadata:
        file?.sourceMetadata && typeof file.sourceMetadata === "object" && !Array.isArray(file.sourceMetadata)
          ? file.sourceMetadata
          : {},
      mediaType: "application/octet-stream",
      clientMediaTypeHash: hashClientString(file?.mediaType || "", "meshrix_upload.media_type"),
      sourceNameHash,
      sourceRelativePathHash,
      sha256,
      byteSize,
      dataBase64
    };
  });

  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        verifiedFiles.map((file) => [file.relativePath, file.sha256, file.byteSize])
      )
    )
    .digest("hex");
  const clientCheckpointId =
    typeof payload?.checkpoint?.checkpointId === "string"
      ? payload.checkpoint.checkpointId.trim()
      : typeof payload?.checkpointId === "string"
        ? payload.checkpointId.trim()
        : "";
  const checkpointId = serverToken("checkpoint", clientCheckpointId || manifestHash, manifestHash);
  const archiveBatch = resolveArchiveBatchIdentity({
    archiveBatchId: payload?.archiveBatchId || payload?.checkpoint?.archiveBatchId,
    batchId: payload?.batchId || payload?.checkpoint?.batchId,
    clientBatchId: payload?.clientBatchId || payload?.checkpoint?.clientBatchId,
    checkpointId: clientCheckpointId || checkpointId,
    manifestDigest: manifestHash
  });
  const receiptFiles = verifiedFiles.map((file) => ({
    name: file.name,
    relativePath: file.relativePath,
    originalFileName: file.originalFileName,
    clientUid: file.clientUid,
    sourceType: file.sourceType,
    providerId: file.providerId,
    externalId: file.externalId,
    syncBatchId: file.syncBatchId,
    contentHash: file.contentHash,
    capturedAt: file.capturedAt,
    sourceMetadata: file.sourceMetadata || {},
    sourceNameHash: file.sourceNameHash,
    sourceRelativePathHash: file.sourceRelativePathHash,
    sha256: file.sha256,
    byteSize: file.byteSize
  }));

  return {
    receipt: {
      checkpointId,
      archiveBatchId: archiveBatch.archiveBatchId,
      clientUid,
      sourceType,
      providerId,
      externalId,
      syncBatchId,
      contentHash,
      capturedAt,
      verifiedAt: new Date().toISOString(),
      manifestSha256: manifestHash,
      fileCount: verifiedFiles.length,
      files: receiptFiles
    },
    uploadedFiles: verifiedFiles
  };
}
