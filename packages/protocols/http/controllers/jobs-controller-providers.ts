export function requireUploadSessionStore(provider: any = null) : any {
  const required: any[] = [
    "appendUploadSessionChunk",
    "buildCheckpointReceiptFromUploadSession",
    "createOrResumeUploadSession",
    "getUploadSession"
  ];
  const missing: any = required.filter((name?: any) : any => typeof provider?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`uploadSessionStore provider is not configured: ${missing.join(", ")}`);
  }
  return provider;
}

export function optionalStorageObjectProvider(provider: any = null) : any {
  return (
    typeof provider?.getObject === "function" &&
    typeof provider?.openObjectReadStream === "function"
  ) ? provider : null;
}

export function requireJobWorkflowProvider(provider: any = null) : any {
  const required: any[] = [
    "createJob",
    "getJob",
    "getJobByCheckpointId",
    "getJobResult",
    "listJobs",
    "reparseJob",
    "cancelJob"
  ];
  const missing: any = required.filter((name?: any) : any => typeof provider?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`jobWorkflowProvider is not configured: ${missing.join(", ")}`);
  }
  return provider;
}

export function createLoadNormalizedDocumentStoreRuntime(loadNormalizedDocumentStore: any = null) : any {
  return typeof loadNormalizedDocumentStore === "function"
    ? loadNormalizedDocumentStore
    : async () : Promise<any> => {
        const error: Error & Record<string, any> = new Error("Normalized document store provider is not configured.");
        error.code = "ENOENT";
        throw error;
      };
}
