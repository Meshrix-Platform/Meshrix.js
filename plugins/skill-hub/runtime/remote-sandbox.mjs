import crypto from "node:crypto";

function failure(code, statusCode = 400) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}

async function acceptScanOutput(receipt, sandboxExecution) {
  if (receipt?.status !== "output_quarantined") return receipt;
  const handle = String(receipt.outputHandle || "");
  if (!handle || typeof sandboxExecution.resolveQuarantinedOutput !== "function" ||
      typeof sandboxExecution.disposeOutput !== "function" || typeof sandboxExecution.getReceipt !== "function") {
    throw new Error("Controlled scan output disposition is unavailable.");
  }
  let disposition = "rejected";
  try {
    const quarantined = await sandboxExecution.resolveQuarantinedOutput(handle);
    const files = Array.isArray(quarantined?.output?.files) ? quarantined.output.files : [];
    if (files.length !== 1 || files[0]?.path !== "scan.json" || files[0]?.bytes > 1024 ||
        typeof quarantined.readFile !== "function") {
      throw new Error("Controlled scan output is invalid.");
    }
    const bytes = await quarantined.readFile("scan.json");
    const scan = JSON.parse(bytes.toString("utf8"));
    if (scan?.scan !== "passed" || Object.keys(scan).length !== 1) {
      throw new Error("Controlled scan was not accepted.");
    }
    disposition = "committed";
  } finally {
    if (await sandboxExecution.disposeOutput(handle, disposition) !== true) {
      throw new Error("Controlled scan output disposition failed.");
    }
  }
  return sandboxExecution.getReceipt(String(receipt.runId || ""));
}

function strictPackage(execution) {
  const encoded = execution?.packageBundleBase64;
  const digest = String(execution?.packageDigest || "");
  if (typeof encoded !== "string" || encoded.length < 4 || encoded.length % 4 !== 0 ||
      encoded.length > 1398104 || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Remote skill package is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024 ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== digest) {
    bytes.fill(0);
    throw new Error("Remote skill package integrity failed.");
  }
  return bytes;
}

export async function executeRemoteSandboxOperation({ operation, input, call, signal, host, remote }) {
  if (typeof host.sandboxExecution?.executeConfigured !== "function") {
    return failure("skill_hub_sandbox_operation_failed", 503);
  }
  const prepared = await remote.request({ operation, input, call, signal, host, phase: "prepare" });
  if (prepared.statusCode >= 400) return prepared;
  const execution = prepared.body?.execution;
  const request = execution?.request;
  let bytes;
  try {
    bytes = strictPackage(execution);
    const packagePath = String(execution.packagePath || "");
    const packageDigest = String(execution.packageDigest || "");
    let receipt = await host.sandboxExecution.executeConfigured(request, async (declared) => {
      if (declared?.handle !== request.inputs?.[0]?.handle || declared?.digest !== request.inputs?.[0]?.digest) {
        throw new Error("Sandbox input binding mismatch.");
      }
      return Object.freeze({
        digest: declared.digest,
        files: Object.freeze([{ path: packagePath, digest: packageDigest, content: bytes }])
      });
    }, { signal });
    if (operation.id === "skill_hub.scan") receipt = await acceptScanOutput(receipt, host.sandboxExecution);
    return remote.request({ operation, input, call, signal, host, phase: "commit", receipt });
  } catch {
    return failure("skill_hub_sandbox_operation_failed");
  } finally {
    bytes?.fill?.(0);
  }
}

export async function sandboxStatusOperation({ operation, input, host }) {
  const executionRef = String(input.executionRef || "").trim();
  if (!executionRef) return failure("skill_hub_sandbox_operation_failed");
  try {
    const value = operation.id === "skill_hub.execution.cancel"
      ? await host.sandboxExecution?.cancel?.(executionRef)
      : await host.sandboxExecution?.getStatus?.(executionRef);
    const status = typeof value === "boolean"
      ? { runId: executionRef, status: value ? "cancellation_requested" : "not_cancelled" }
      : value || { runId: executionRef, status: "unknown" };
    return Object.freeze({
      statusCode: 200,
      headers: Object.freeze({ "content-type": "application/json" }),
      body: Object.freeze({
        schemaVersion: "v0.0.1:schema:definition-1",
        ok: true,
        protocolVersion: "v0.0.1:skill-hub:runtime-1",
        runId: String(status.runId || executionRef),
        status: String(status.status || "unknown"),
        reasonCode: String(status.reasonCode || ""),
        cleanupStatus: String(status.cleanupState || ""),
        outputDisposition: String(status.outputDisposition || "")
      })
    });
  } catch {
    return failure("skill_hub_sandbox_operation_failed");
  }
}
