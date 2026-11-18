import { describe, expect, it } from "vitest";

import {
  classifyNodeRuntimeFailure,
  NODE_RUNTIME_DIAGNOSTIC_PHASES
} from "../../../tools/server-scripts/lib/node-runtime-diagnostics.ts";

describe("pinned Node runtime diagnostics", () => {
  it.each([
    ["node_runtime_lock_invalid", "lock"],
    ["node_runtime_pinned_download_failed", "download"],
    ["node_runtime_download_size_mismatch", "size"],
    ["node_runtime_download_digest_mismatch", "digest"],
    ["node_runtime_signed_checksums_invalid", "signed-checksum"],
    ["node_runtime_signature_signer_mismatch", "signer"],
    ["node_runtime_signature_invalid", "signature"]
  ])("maps %s to the stable %s phase", (errorCode, phase) => {
    expect(classifyNodeRuntimeFailure(new Error(errorCode))).toEqual({ phase, errorCode });
  });

  it("uses one closed pair for unexpected cleanup and report failures", () => {
    expect(classifyNodeRuntimeFailure(new Error("private detail"), "cleanup")).toEqual({
      phase: "cleanup",
      errorCode: "node_runtime_cleanup_failed"
    });
    expect(classifyNodeRuntimeFailure(new Error("private detail"), "report-finalization")).toEqual({
      phase: "report-finalization",
      errorCode: "node_runtime_report_finalization_failed"
    });
    expect(NODE_RUNTIME_DIAGNOSTIC_PHASES).toHaveLength(10);
  });
});
