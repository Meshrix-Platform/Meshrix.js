import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
  SANDBOX_DENIAL_REASONS,
  SANDBOX_RECEIPT_SCHEMA,
  controlledRef,
  sandboxDigest
} from "../execution-sandbox/index.ts";

const DEFAULT_TIMEOUT_MS: any = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES: any = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES: any = 1024 * 1024;

function verifierError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function boundedPositiveInteger(value?: any, fallback?: any, maximum?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function resolveVerifierSourceWithAuthority(source?: any, resolveSource?: any) : Promise<any> {
  const relativeScript: any = String(source || "").trim();
  if (!/^verifiers\/[A-Za-z0-9][A-Za-z0-9._/-]*\.mjs$/u.test(relativeScript) ||
      relativeScript.includes("\\") ||
      relativeScript.split("/").some((segment?: any) : any => segment === ".." || segment === "")) {
    throw verifierError("PLUGIN_VERIFIER_SOURCE_INVALID", "Plugin verifier source must be a bounded artifact-relative .mjs file.");
  }
  const resolved: any = await resolveSource(relativeScript);
  const absolutePath: any = fileURLToPath(resolved);
  const stat: any = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw verifierError("PLUGIN_VERIFIER_SCRIPT_INVALID", "Plugin verifier scripts must be regular non-symbolic-link files.");
  }
  return Object.freeze({
    root: "",
    absolutePath,
    relativePath: relativeScript,
    bytes: stat.size,
    device: stat.dev,
    inode: stat.ino
  });
}

function readVerifierSource(script?: any) : any {
  const descriptor: any = fs.openSync(
    script.absolutePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const stat: any = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== script.device || stat.ino !== script.inode || stat.size !== script.bytes) {
      throw verifierError("PLUGIN_VERIFIER_SCRIPT_INVALID", "Plugin verifier source changed during admission.");
    }
    const source: any = Buffer.allocUnsafe(stat.size);
    let offset: any = 0;
    while (offset < source.length) {
      const bytesRead: any = fs.readSync(descriptor, source, offset, source.length - offset, offset);
      if (bytesRead === 0) throw verifierError("PLUGIN_VERIFIER_SCRIPT_INVALID", "Plugin verifier source is incomplete.");
      offset += bytesRead;
    }
    return source;
  } finally {
    fs.closeSync(descriptor);
  }
}

function failedResult(reasonCode?: any, {
  timedOut = false,
  outputLimitExceeded = false,
  outputBytes = 0,
  terminalReceiptRef = ""
}: Record<string, any> = {}) : any {
  return Object.freeze({
    ok: false,
    exitCode: -1,
    signal: timedOut ? "SIGKILL" : "",
    timedOut,
    outputLimitExceeded,
    outputBytes,
    reasonCode,
    terminalReceiptRef
  });
}

function normalizeIdentity(value?: any, label?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw verifierError("PLUGIN_VERIFIER_SANDBOX_CONFIGURATION_REQUIRED", `${label} is required for sandbox execution.`);
  }
  return value;
}

function verifierResources(timeoutMs?: any, maxOutputBytes?: any, sourceBytes?: any) : any {
  const diskBytes: any = Math.max(4096, sourceBytes + 4096);
  return Object.freeze({
    wallTimeMs: timeoutMs,
    cpuMillis: timeoutMs,
    memoryBytes: 256 * 1024 * 1024,
    processes: 32,
    fileDescriptors: 128,
    diskBytes,
    inodes: 64,
    fileCount: 16,
    outputBytes: 4096,
    logBytes: maxOutputBytes,
    networkBytes: 1,
    toolCalls: 1
  });
}

function terminalReceiptRef(receipt?: any) : any {
  if (!receipt || typeof receipt !== "object") return "";
  return controlledRef(sandboxDigest({
    schemaVersion: receipt.schemaVersion,
    runId: receipt.runId,
    requestDigest: receipt.requestDigest || "",
    status: receipt.status,
    runtimeState: receipt.runtimeState,
    cleanupState: receipt.cleanupState
  }), "sandbox-receipt");
}

function receiptResult(receipt?: any, maxOutputBytes?: any, pluginId?: any, inputDigest?: any) : any {
  if (!receipt || receipt.schemaVersion !== SANDBOX_RECEIPT_SCHEMA || !String(receipt.runId || "").startsWith("run:")) {
    return failedResult("plugin_verifier_receipt_invalid");
  }
  const receiptRef: any = terminalReceiptRef(receipt);
  if (receipt.pluginRef !== controlledRef(pluginId, "plugin")) {
    return failedResult("plugin_verifier_receipt_invalid", { terminalReceiptRef: receiptRef });
  }
  if (
    !Array.isArray(receipt.inputDigests) ||
    receipt.inputDigests.length !== 1 ||
    receipt.inputDigests[0] !== inputDigest
  ) {
    return failedResult("plugin_verifier_receipt_invalid", { terminalReceiptRef: receiptRef });
  }
  const outputBytes: any = Math.min(
    Math.max(0, Number(receipt.resourceTotals?.logBytes || 0)),
    maxOutputBytes
  );
  const timedOut: any = receipt.reasonCode === SANDBOX_DENIAL_REASONS.TIMED_OUT || receipt.status === "timed_out";
  const outputLimitExceeded: any = receipt.reasonCode === SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED;
  if (receipt.status !== "succeeded") {
    return failedResult(String(receipt.reasonCode || SANDBOX_DENIAL_REASONS.RUNTIME_FAILED), {
      timedOut,
      outputLimitExceeded,
      outputBytes,
      terminalReceiptRef: receiptRef
    });
  }
  if (receipt.runtimeState !== "succeeded" || receipt.cleanupState !== "destroyed") {
    return failedResult("plugin_verifier_receipt_invalid", {
      outputBytes,
      terminalReceiptRef: receiptRef
    });
  }
  return Object.freeze({
    ok: true,
    exitCode: 0,
    signal: "",
    timedOut: false,
    outputLimitExceeded: false,
    outputBytes,
    reasonCode: "sandbox_succeeded",
    terminalReceiptRef: receiptRef
  });
}

export async function runPluginVerifierWorkload(declaration: Record<string, any> = {}, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
  sandboxExecution = null,
  principal = null,
  governance = null,
  pluginId = "",
  signal = null,
  idempotencyKey = "",
  resolveSource = null
}: Record<string, any> = {}) : Promise<any> {
  if (typeof resolveSource !== "function") {
    throw verifierError(
      "PLUGIN_VERIFIER_ARTIFACT_AUTHORITY_REQUIRED",
      "Plugin verifier source requires a verified installed-artifact resolver."
    );
  }
  const script: any = await resolveVerifierSourceWithAuthority(declaration.source, resolveSource);
  if (!/^plugin_verifier\.[a-z][a-z0-9._-]*$/u.test(String(declaration.workloadKind || ""))) {
    throw verifierError(
      "PLUGIN_VERIFIER_WORKLOAD_INVALID",
      "Plugin verifier workloadKind must identify a dedicated configured plugin_verifier.* workload."
    );
  }
  const effectiveTimeoutMs: any = boundedPositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000);
  const effectiveMaxOutputBytes: any = boundedPositiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024 * 1024);
  const effectiveMaxSourceBytes: any = boundedPositiveInteger(maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 8 * 1024 * 1024);
  if (script.bytes <= 0 || script.bytes > effectiveMaxSourceBytes) {
    throw verifierError("PLUGIN_VERIFIER_SCRIPT_INVALID", "Plugin verifier source exceeds its admitted size.");
  }
  if (!sandboxExecution || typeof sandboxExecution.executeConfigured !== "function") {
    return failedResult("plugin_verifier_sandbox_configuration_required");
  }

  let boundPrincipal: any;
  let boundGovernance: any;
  try {
    boundPrincipal = normalizeIdentity(principal, "Plugin verifier principal");
    boundGovernance = normalizeIdentity(governance, "Plugin verifier governance");
  } catch (error: any) {
    return failedResult(error.code || "plugin_verifier_sandbox_configuration_required");
  }

  const source: any = readVerifierSource(script);
  const sourceDigest: any = crypto.createHash("sha256").update(source).digest("hex");
  const inputDigest: any = sandboxDigest([{ path: script.relativePath, digest: sourceDigest }]);
  const request: Readonly<Record<string, any>> = Object.freeze({
    schemaVersion: SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
    workloadKind: declaration.workloadKind,
    principal: boundPrincipal,
    invocation: Object.freeze({ args: [script.relativePath], workingDirectory: "workspace" }),
    inputs: Object.freeze([{ handle: `plugin-verifier-source:${sourceDigest}`, digest: inputDigest, readOnly: true }]),
    outputs: Object.freeze({ schema: "plugin-verifier-output", maxFiles: 1, maxBytes: 4096, allowedTypes: ["json"] }),
    capabilities: Object.freeze({
      filesystem: ["input:read", "scratch:write", "output:write"],
      network: [],
      tools: [],
      secretRefs: [],
      clock: true,
      randomness: false,
      subprocesses: 0
    }),
    resources: verifierResources(effectiveTimeoutMs, effectiveMaxOutputBytes, source.length),
    governance: boundGovernance,
    idempotencyKey: String(idempotencyKey || `plugin-verifier:${pluginId || "plugin"}:${declaration.id || sourceDigest}:${crypto.randomUUID()}`),
    deadlineAt: new Date(Date.now() + effectiveTimeoutMs).toISOString()
  });

  try {
    const execution: any = sandboxExecution.executeConfigured(request, async (declared?: any) : Promise<any> => {
      if (declared.handle !== request.inputs[0].handle || declared.digest !== inputDigest) {
        throw verifierError("PLUGIN_VERIFIER_INPUT_INVALID", "Plugin verifier sandbox input binding is invalid.");
      }
      return Object.freeze({
        digest: inputDigest,
        files: Object.freeze([{ path: script.relativePath, digest: sourceDigest, content: source }])
      });
    }, { pluginId: String(pluginId || ""), signal });
    return receiptResult(
      await execution,
      effectiveMaxOutputBytes,
      String(pluginId || ""),
      inputDigest
    );
  } catch (error: any) {
    return failedResult(String(error?.code || SANDBOX_DENIAL_REASONS.RUNTIME_FAILED));
  } finally {
    source.fill(0);
  }
}

export function createPluginVerifierHooks(manifest?: any, options: Record<string, any> = {}) : any {
  const hooks: any = manifest?.verifierHooks;
  if (!Array.isArray(hooks)) {
    throw verifierError("PLUGIN_VERIFIER_MANIFEST_INVALID", "Plugin verifier hooks must be declared by the manifest.");
  }
  return Object.freeze(Object.fromEntries(hooks.map((declaration?: any) : any => [
    declaration.id,
    Object.freeze({
      run: (executionOptions: Record<string, any> = {}) : any => runPluginVerifierWorkload(declaration, {
        ...options,
        ...executionOptions,
        pluginId: executionOptions.pluginId || options.pluginId || manifest.id
      })
    })
  ])));
}
