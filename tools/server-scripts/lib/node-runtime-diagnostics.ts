export const NODE_RUNTIME_DIAGNOSTIC_PHASES: readonly string[] = Object.freeze([
  "lock",
  "download",
  "size",
  "digest",
  "signed-checksum",
  "signer",
  "signature",
  "fixture",
  "cleanup",
  "report-finalization"
]);

export function classifyNodeRuntimeFailure(error: unknown, fallbackPhase = "fixture") {
  const raw = String((error as any)?.code || (error as any)?.message || "").trim().toLowerCase();
  const causeCode = String((error as any)?.cause?.code || "").trim().toUpperCase();
  const errorCode = /^node_runtime_[a-z0-9_]+$/u.test(raw)
    ? raw
    : ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(causeCode)
      ? "node_runtime_download_failed"
    : `node_runtime_${fallbackPhase.replaceAll("-", "_")}_failed`;
  const phase = /(?:^|_)lock_|version_not_locked|target_not_locked|cache_/u.test(errorCode)
    ? "lock"
    : /size/u.test(errorCode)
      ? "size"
      : /signed_checksums|checksums_/u.test(errorCode)
        ? "signed-checksum"
        : /signer/u.test(errorCode)
          ? "signer"
          : /signature/u.test(errorCode)
            ? "signature"
            : /digest/u.test(errorCode)
              ? "digest"
              : /download/u.test(errorCode)
                ? "download"
                : NODE_RUNTIME_DIAGNOSTIC_PHASES.includes(fallbackPhase)
                  ? fallbackPhase
                  : "fixture";
  return Object.freeze({ phase, errorCode });
}
