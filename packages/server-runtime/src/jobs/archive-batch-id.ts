import { hashClientString, isServerToken, serverToken } from "#meshrix/product-api";

function stringValue(value?: any) : any {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: any[]) : any {
  for (const value of values) {
    const text: any = stringValue(value);
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
}: Record<string, any> = {}) : any {
  const explicit: any = firstString(archiveBatchId, batchId, clientBatchId);
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

  const source: any = firstString(manifestDigest, inputDigest, checkpointId);
  if (!source) {
    return {
      archiveBatchId: "",
      clientArchiveBatchHash: "",
      archiveBatchSource: ""
    };
  }

  const normalizedManifestDigest: any = stringValue(manifestDigest).toLowerCase();
  const normalizedInputDigest: any = stringValue(inputDigest).toLowerCase();
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
