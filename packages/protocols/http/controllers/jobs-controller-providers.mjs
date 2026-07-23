export function requireUploadSessionStore(provider = null) {
  const required = [
    "appendUploadSessionChunk",
    "buildCheckpointReceiptFromUploadSession",
    "createOrResumeUploadSession",
    "getUploadSession"
  ];
  const missing = required.filter((name) => typeof provider?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`uploadSessionStore provider is not configured: ${missing.join(", ")}`);
  }
  return provider;
}

export function optionalStorageObjectProvider(provider = null) {
  return (
    typeof provider?.getObject === "function" &&
    typeof provider?.readObject === "function"
  ) ? provider : null;
}

export function requireJobWorkflowProvider(provider = null) {
  const required = [
    "createJob",
    "getJob",
    "getJobByCheckpointId",
    "getJobResult",
    "listJobs",
    "reparseJob",
    "cancelJob"
  ];
  const missing = required.filter((name) => typeof provider?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`jobWorkflowProvider is not configured: ${missing.join(", ")}`);
  }
  return provider;
}

export function createLoadNormalizedDocumentStoreRuntime(loadNormalizedDocumentStore = null) {
  return typeof loadNormalizedDocumentStore === "function"
    ? loadNormalizedDocumentStore
    : async () => {
        const error = new Error("Normalized document store provider is not configured.");
        error.code = "ENOENT";
        throw error;
      };
}
