import { hashClientString, isServerToken, serverToken } from "#meshrix/product-api";

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) {
      return text;
    }
  }
  return "";
}

export function resolveArchiveBatchIdentity({
  archiveBatchId = "",
  batchId = "",
  clientBatchId = "",
  checkpointId = "",
  manifestDigest = "",
  inputDigest = ""
} = {}) {
  const explicit = firstString(archiveBatchId, batchId, clientBatchId);
  if (explicit) {
    return {
      archiveBatchId: explicit,
      clientArchiveBatchHash: isServerToken(explicit, "archive_batch")
        ? ""
        : hashClientString(explicit, "archive_batch.source"),
      archiveBatchSource: isServerToken(explicit, "archive_batch")
        ? "server_token"
        : "client_batch"
    };
  }

  const source = firstString(manifestDigest, inputDigest, checkpointId);
  if (!source) {
    return {
      archiveBatchId: "",
      clientArchiveBatchHash: "",
      archiveBatchSource: ""
    };
  }

  const normalizedManifestDigest = stringValue(manifestDigest).toLowerCase();
  const normalizedInputDigest = stringValue(inputDigest).toLowerCase();
  return {
    archiveBatchId: serverToken(
      "archive_batch",
      source,
      normalizedManifestDigest,
      normalizedInputDigest
    ),
    clientArchiveBatchHash: hashClientString(source, "archive_batch.source"),
    archiveBatchSource: explicit ? "client_batch" : manifestDigest ? "manifest" : "checkpoint"
  };
}
