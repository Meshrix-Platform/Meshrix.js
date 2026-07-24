#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  SANDBOX_DENIAL_REASONS,
  SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
  SANDBOX_REQUEST_SCHEMA,
  sandboxDigest
} from "@meshrix/foundation/execution-sandbox/contracts";
import { createSandboxExecutionBroker } from "@meshrix/server-runtime/execution-sandbox/broker";
import { createOciBackendConformanceTarget } from "@meshrix/server-runtime/execution-sandbox/trusted-oci-provider-adapters";
import {
  loadTrustedSandboxProviderReceipts,
  writeTrustedSandboxProviderReceipts
} from "@meshrix/server-runtime/execution-sandbox/trusted-provider-receipt-store";
import { createSandboxProviderConformanceReceipt } from "@meshrix/server-runtime/execution-sandbox/trusted-provider-resolver";
import {
  createTrustedSandboxProviderResolver,
  REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS
} from "@meshrix/server-runtime/execution-sandbox/trusted-provider-resolver";
import { createSourceEvidenceContext } from "./lib/source-tree-digest.mjs";

const REPORT_SCHEMA = "v0.0.1:execution-sandbox:oci-conformance-report-1";
const REPORT_PATH = "build/reports/execution-sandbox-oci-conformance.json";
const VERIFIER = "tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs";
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PINNED_OCI_CONFORMANCE_IMAGE =
  "node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203";
const PINNED_IMAGE = PINNED_OCI_CONFORMANCE_IMAGE;
const OCI_ENGINE_READY_TIMEOUT_MS = 120_000;
const OCI_ENGINE_READY_INTERVAL_MS = 2_500;
const OCI_IMAGE_PULL_TIMEOUT_MS = 600_000;
const POLICY_REVISION = "execution-sandbox-oci-policy";
const RUNTIME_PROFILE = "hardened-oci";
const OPERATOR_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ADVERSARIAL_PROFILE = "oci-adversarial";
const ADVERSARIAL_POLICY_REVISION = "oci-adversarial-policy";

const RESOURCE_PROBE_SOURCE = String.raw`
import fs from "node:fs";

function readText(target) {
  try { return fs.readFileSync(target, "utf8").trim(); } catch { return ""; }
}

function boundedInteger(value, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum;
}

const memoryMax = readText("/sys/fs/cgroup/memory.max");
const pidsMax = readText("/sys/fs/cgroup/pids.max");
const cpuMax = readText("/sys/fs/cgroup/cpu.max").split(/\s+/u);
const limits = readText("/proc/self/limits");
const nofile = /^Max open files\s+(\d+)\s+(\d+)/imu.exec(limits);
const quota = Number.parseInt(cpuMax[0], 10);
const period = Number.parseInt(cpuMax[1], 10);
const result = {
  linuxRuntime: process.platform === "linux",
  memoryBounded: boundedInteger(memoryMax, 128 * 1024 * 1024),
  pidsBounded: boundedInteger(pidsMax, 16),
  fileDescriptorsBounded:
    Boolean(nofile) && boundedInteger(nofile[1], 32) && boundedInteger(nofile[2], 32),
  cpuBounded:
    Number.isSafeInteger(quota) && quota > 0 &&
    Number.isSafeInteger(period) && period > 0 &&
    quota / period <= 0.251
};
fs.writeFileSync("/sandbox/output/result.json", JSON.stringify(result));
`;

const LONG_RUNNING_SOURCE = String.raw`
setInterval(() => {}, 1_000);
`;

const READY_LONG_RUNNING_SOURCE = String.raw`
import fs from "node:fs";
fs.writeFileSync("/sandbox/output/ready", "ready");
setInterval(() => {}, 1_000);
`;

const OUTPUT_OVERFLOW_SOURCE = String.raw`
import fs from "node:fs";
fs.writeFileSync("/sandbox/output/first.json", JSON.stringify({ payload: "x".repeat(128) }));
fs.writeFileSync("/sandbox/output/second.json", "{}");
`;

const LOG_OVERFLOW_SOURCE = String.raw`
process.stdout.write("x".repeat(8 * 1024));
`;

const SUBPROCESS_DENIAL_SOURCE = String.raw`
import fs from "node:fs";
import { spawnSync } from "node:child_process";
let subprocessDenied = false;
try {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    timeout: 1_000
  });
  subprocessDenied = Boolean(child.error) || child.status !== 0;
} catch (error) {
  subprocessDenied = error?.code === "ERR_ACCESS_DENIED";
}
fs.writeFileSync("/sandbox/output/result.json", JSON.stringify({
  subprocessDenied
}));
`;

function argumentValue(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    const error = new Error("A required OCI conformance argument is missing.");
    error.code = "execution_sandbox_oci_argument_missing";
    throw error;
  }
  return value;
}

function boundedOperatorValue(value, errorCode) {
  const normalized = String(value || "").trim();
  if (!OPERATOR_VALUE_PATTERN.test(normalized)) {
    const error = new Error("An OCI conformance argument is invalid.");
    error.code = errorCode;
    throw error;
  }
  return normalized;
}

function publicErrorCode(error) {
  const code = String(error?.code || "");
  return /^[a-z][a-z0-9_]{0,95}$/u.test(code) ? code : "execution_sandbox_oci_failed";
}

function boundedProbeFailure(error) {
  const code = String(error?.code || "");
  const failureStage = String(error?.failureStage || "");
  return Object.freeze({
    code: /^(?:sandbox_[a-z_]+)$/u.test(code) ? code : "sandbox_runtime_failed",
    failureStage: /^(?:oci_(?:create|start|inspect|command|workload)_failed)$/u.test(failureStage)
      ? failureStage
      : "sandbox_backend_failed"
  });
}

function runOciEngineCommand(binary, args, {
  timeoutMs = 30_000,
  allowFailure = false,
  maxBuffer = 16 * 1024
} = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: {},
    maxBuffer
  });
  if (!allowFailure && result.status !== 0) {
    const error = new Error("An OCI engine command failed.");
    error.code = "execution_sandbox_oci_engine_command_failed";
    throw error;
  }
  return result;
}

export function ociPinnedImagePresent(binary, image = PINNED_IMAGE) {
  return runOciEngineCommand(binary, ["image", "inspect", image], {
    allowFailure: true,
    timeoutMs: 30_000
  }).status === 0;
}

export function ensureOciPinnedImage(binary, image = PINNED_IMAGE) {
  if (ociPinnedImagePresent(binary, image)) {
    return Object.freeze({ present: true, pulled: false });
  }
  const pull = runOciEngineCommand(binary, ["pull", image], {
    allowFailure: true,
    timeoutMs: OCI_IMAGE_PULL_TIMEOUT_MS,
    maxBuffer: 64 * 1024
  });
  if (pull.status !== 0 || !ociPinnedImagePresent(binary, image)) {
    const error = new Error("The digest-pinned OCI conformance image is unavailable.");
    error.code = "execution_sandbox_oci_pinned_image_missing";
    throw error;
  }
  return Object.freeze({ present: true, pulled: true });
}

export async function waitForOciEngineReady(binary, {
  timeoutMs = OCI_ENGINE_READY_TIMEOUT_MS,
  intervalMs = OCI_ENGINE_READY_INTERVAL_MS
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const result = runOciEngineCommand(binary, ["info", "--format", "{{json .ServerVersion}}"], {
      allowFailure: true,
      timeoutMs: 8_000
    });
    if (result.status === 0 && result.stdout.trim()) {
      return Object.freeze({ ready: true, waitedMs: Date.now() - started });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error("The OCI engine daemon is unavailable.");
  error.code = "execution_sandbox_oci_daemon_unavailable";
  throw error;
}

export async function runOciConformancePreflight(target, {
  image = PINNED_IMAGE,
  waitForEngine = waitForOciEngineReady,
  ensureImage = ensureOciPinnedImage
} = {}) {
  const binary = String(target?.binary || "").trim();
  if (!binary) {
    const error = new Error("The OCI conformance target does not expose a provider binary.");
    error.code = "execution_sandbox_oci_target_missing";
    throw error;
  }
  await waitForEngine(binary);
  return ensureImage(binary, image);
}

export function parseExecutionSandboxOciConformanceArguments(argv = []) {
  const [action, ...argumentsList] = argv;
  if (action !== "provision" && action !== "revoke") {
    const error = new Error("An explicit OCI conformance action is required.");
    error.code = "execution_sandbox_oci_action_required";
    throw error;
  }
  const options = { action };
  const seenOptions = new Set();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index];
    if (seenOptions.has(option)) {
      const error = new Error("An OCI conformance argument was provided more than once.");
      error.code = "execution_sandbox_oci_argument_duplicate";
      throw error;
    }
    seenOptions.add(option);
    if (option === "--user-data-path") {
      options.userDataPath = argumentValue(argumentsList, index);
      index += 1;
    } else if (option === "--policy-revision") {
      options.policyRevision = argumentValue(argumentsList, index);
      index += 1;
    } else if (option === "--runtime-profile") {
      options.runtimeProfile = argumentValue(argumentsList, index);
      index += 1;
    } else if (option === "--provider-id") {
      options.providerId = argumentValue(argumentsList, index);
      index += 1;
    } else {
      const error = new Error("An OCI conformance argument is not supported.");
      error.code = "execution_sandbox_oci_argument_unknown";
      throw error;
    }
  }
  const userDataPath = String(options.userDataPath || "").trim();
  if (!userDataPath || !path.isAbsolute(userDataPath) || userDataPath.includes("\0") || userDataPath.length > 4_096) {
    const error = new Error("An explicit absolute runtime data path is required.");
    error.code = "execution_sandbox_oci_user_data_path_invalid";
    throw error;
  }
  if (action === "provision") {
    if (options.providerId) {
      const error = new Error("A provider identifier is not accepted while provisioning.");
      error.code = "execution_sandbox_oci_argument_invalid";
      throw error;
    }
    return Object.freeze({
      action,
      userDataPath,
      policyRevision: boundedOperatorValue(
        options.policyRevision,
        "execution_sandbox_oci_policy_revision_invalid"
      ),
      runtimeProfile: boundedOperatorValue(
        options.runtimeProfile,
        "execution_sandbox_oci_runtime_profile_invalid"
      )
    });
  }
  if (options.policyRevision || options.runtimeProfile) {
    const error = new Error("Policy and profile arguments are not accepted while revoking.");
    error.code = "execution_sandbox_oci_argument_invalid";
    throw error;
  }
  return Object.freeze({
    action,
    userDataPath,
    providerId: boundedOperatorValue(options.providerId, "execution_sandbox_oci_provider_id_invalid")
  });
}

export async function revokeTrustedOciConformanceReceipt({ userDataPath, providerId } = {}) {
  const normalizedProviderId = boundedOperatorValue(
    providerId,
    "execution_sandbox_oci_provider_id_invalid"
  );
  const receipts = { ...loadTrustedSandboxProviderReceipts({ userDataPath }) };
  delete receipts[normalizedProviderId];
  return writeTrustedSandboxProviderReceipts({ userDataPath, receipts });
}

const PROBE_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";

function deniedWrite(target) {
  try { fs.writeFileSync(target, "denied"); return false; } catch { return true; }
}

function networkDenied() {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host: "169.254.169.254", port: 80 });
    } catch {
      resolve(true);
      return;
    }
    const done = (denied) => { socket.destroy(); resolve(denied); };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(250, () => done(true));
  });
}

function namespaceIdentity(name) {
  try { return fs.readlinkSync("/proc/self/ns/" + name); } catch { return ""; }
}

function mountOptions(target) {
  const record = fs.readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .find((line) => line.split(" ")[1] === target);
  return new Set((record?.split(" ")[3] || "").split(",").filter(Boolean));
}

const status = fs.readFileSync("/proc/self/status", "utf8");
const capEff = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1] || "";
const noNewPrivileges = /^NoNewPrivs:\s*1$/imu.test(status);
const seccompFilterActive = /^Seccomp:\s*2$/imu.test(status);
const sensitiveEnvironmentAbsent = Object.keys(process.env).every((key) =>
  !/(?:token|secret|password|credential|api[_-]?key)/iu.test(key)
);
const input = fs.readFileSync("probe-input.txt", "utf8").trim();
const scratchStat = fs.statSync("/sandbox/scratch");
const scratchFs = fs.statfsSync("/sandbox/scratch");
const scratchOptions = mountOptions("/sandbox/scratch");
const outputStat = fs.statSync("/sandbox/output");
const exposedBlockDevices = fs.readdirSync("/dev").filter((name) => {
  try { return fs.statSync("/dev/" + name).isBlockDevice(); } catch { return false; }
});
const result = {
  linuxRuntime: process.platform === "linux",
  nonRootIdentity: typeof process.getuid === "function" && process.getuid() > 0,
  immutableInputReadable: input === "isolated-input",
  immutableInputWriteDenied: deniedWrite("probe-input.txt"),
  rootFilesystemWriteDenied: deniedWrite("/etc/meshrix-sandbox-write-probe"),
  capabilitiesDropped: Boolean(capEff) && /^0+$/u.test(capEff),
  noNewPrivileges,
  seccompFilterActive,
  deviceNodesRestricted:
    exposedBlockDevices.length === 0 &&
    !fs.existsSync("/dev/mem") &&
    !fs.existsSync("/dev/kmsg"),
  networkDenied: await networkDenied(),
  sensitiveEnvironmentAbsent,
  containerControlSocketAbsent: !fs.existsSync("/var/run/docker.sock") && !fs.existsSync("/run/podman/podman.sock"),
  isolationNamespaces: {
    ipc: namespaceIdentity("ipc"),
    mount: namespaceIdentity("mnt"),
    network: namespaceIdentity("net"),
    pid: namespaceIdentity("pid"),
    uts: namespaceIdentity("uts")
  },
  scratchQuotaBounded:
    (scratchStat.mode & 0o777) === 0o700 &&
    scratchStat.uid === process.getuid() &&
    scratchStat.gid === process.getgid() &&
    scratchFs.blocks * scratchFs.bsize <= 16 * 1024 * 1024 &&
    scratchFs.files <= 256 &&
    ["rw", "noexec", "nosuid", "nodev"].every((option) => scratchOptions.has(option)),
  privateOutputOwned:
    (outputStat.mode & 0o777) === 0o700 &&
    outputStat.uid === process.getuid() &&
    outputStat.gid === process.getgid()
};
fs.writeFileSync("/sandbox/output/result.json", JSON.stringify(result));
`;

async function privateDirectory(directoryPath, mode = 0o700) {
  await fs.mkdir(directoryPath, { recursive: true, mode });
  await fs.chmod(directoryPath, mode);
}

async function removePrivateTree(root) {
  async function makeWritable(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await fs.chmod(current, 0o700).catch(() => {});
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeWritable(path.join(current, entry.name));
      } else {
        await fs.chmod(path.join(current, entry.name), 0o600).catch(() => {});
      }
    }
  }
  await makeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}

async function runProbe(target, root, runId) {
  const runRoot = path.join(root, runId);
  const inputRoot = path.join(runRoot, "input");
  const inputDirectory = path.join(inputRoot, "0");
  const scratchRoot = path.join(runRoot, "scratch");
  const outputRoot = path.join(runRoot, "output");
  await privateDirectory(runRoot);
  await privateDirectory(inputRoot);
  await privateDirectory(inputDirectory);
  await privateDirectory(scratchRoot);
  await privateDirectory(outputRoot);
  await fs.writeFile(path.join(inputDirectory, "probe.mjs"), PROBE_SOURCE, { mode: 0o444 });
  await fs.writeFile(path.join(inputDirectory, "probe-input.txt"), "isolated-input\n", { mode: 0o444 });
  await fs.chmod(inputDirectory, 0o555);
  await fs.chmod(inputRoot, 0o555);
  const request = Object.freeze({
    artifact: Object.freeze({ entryPoint: "probe.mjs" }),
    invocation: Object.freeze({ workingDirectory: "input/0", args: Object.freeze([]) }),
    resources: Object.freeze({
      wallTimeMs: 10_000,
      cpuMillis: 2_000,
      memoryBytes: 128 * 1024 * 1024,
      processes: 64,
      fileDescriptors: 64,
      diskBytes: 16 * 1024 * 1024,
      inodes: 256,
      fileCount: 128,
      outputBytes: 64 * 1024,
      logBytes: 64 * 1024,
      networkBytes: 1,
      toolCalls: 1
    }),
    outputs: Object.freeze({ maxBytes: 64 * 1024, maxFiles: 4 })
  });
  const policy = Object.freeze({
    workload: Object.freeze({ image: PINNED_IMAGE, command: Object.freeze(["node"]) }),
    capabilities: Object.freeze({ network: [], secretRefs: [], tools: [], subprocesses: 0 })
  });
  const context = Object.freeze({
    runId,
    request,
    policy,
    paths: Object.freeze({ inputRoot, scratchRoot, outputRoot }),
    signal: new AbortController().signal
  });
  const execution = await target.backend.run(context);
  const directResult = path.join(outputRoot, "result.json");
  const nestedResult = path.join(outputRoot, "output", "result.json");
  const resultPath = await fs.access(directResult).then(() => directResult).catch(async () => {
    await fs.access(nestedResult);
    return nestedResult;
  });
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  const cleanup = await target.backend.cleanup(context);
  return { execution, result, cleanup };
}

function adversarialResources(overrides = {}) {
  return Object.freeze({
    wallTimeMs: 2_000,
    cpuMillis: 500,
    memoryBytes: 128 * 1024 * 1024,
    processes: 16,
    fileDescriptors: 32,
    diskBytes: 4 * 1024 * 1024,
    inodes: 128,
    fileCount: 64,
    outputBytes: 64 * 1024,
    logBytes: 4 * 1024,
    networkBytes: 1,
    toolCalls: 1,
    ...overrides
  });
}

function adversarialPolicy(capabilities = {}) {
  return Object.freeze({
    workload: Object.freeze({ image: PINNED_IMAGE, command: Object.freeze(["node"]) }),
    capabilities: Object.freeze({
      network: Object.freeze([]),
      secretRefs: Object.freeze([]),
      tools: Object.freeze([]),
      subprocesses: 0,
      ...capabilities
    })
  });
}

function brokerDescriptor(target) {
  return Object.freeze({
    id: target.id,
    providerClass: target.providerClass,
    isolationClass: target.isolationClass,
    serviceIdentityRef: target.serviceIdentityRef,
    executableIdentityDigest: target.executableIdentityDigest,
    healthy: true,
    production: true,
    enforcedRestrictions: REQUIRED_SANDBOX_PROVIDER_RESTRICTIONS
  });
}

function brokerRequest(source, { kind, resources, outputs, idempotencyKey } = {}) {
  const sourceDigest = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  const inputDigest = sandboxDigest([{ path: "probe.mjs", digest: sourceDigest }]);
  return Object.freeze({
    sourceDigest,
    inputDigest,
    request: Object.freeze({
      schemaVersion: SANDBOX_REQUEST_SCHEMA,
      workloadKind: kind,
      principal: Object.freeze({
        subjectRef: "oci-conformance-subject",
        tenantRef: "oci-conformance-tenant",
        workspaceRef: "oci-conformance-workspace",
        operationRef: "execution_sandbox.conformance"
      }),
      artifact: Object.freeze({ digest: sourceDigest, runtimeKind: "oci", entryPoint: "probe.mjs" }),
      invocation: Object.freeze({ args: Object.freeze([]), workingDirectory: "input/0" }),
      inputs: Object.freeze([{ handle: "conformance-input", digest: inputDigest, readOnly: true }]),
      outputs: Object.freeze(outputs || {
        schema: "oci-conformance-output",
        maxFiles: 2,
        maxBytes: 64 * 1024,
        allowedTypes: Object.freeze(["json"])
      }),
      capabilities: Object.freeze({
        filesystem: Object.freeze(["input:read", "output:write"]),
        network: Object.freeze([]),
        tools: Object.freeze([]),
        secretRefs: Object.freeze([]),
        clock: false,
        randomness: false,
        subprocesses: 0
      }),
      resources,
      governance: Object.freeze({
        grantRef: "oci-conformance-grant",
        approvalRef: "",
        approvalBindingDigest: "",
        approvalSourceDigest: "",
        approvalRequestDigest: "",
        approvalExpiresAt: "",
        authorizationContextDigest: crypto.createHash("sha256").update("oci-conformance-authorization").digest("hex"),
        riskDecisionRef: "oci-conformance-risk",
        policyRevision: ADVERSARIAL_POLICY_REVISION,
        authorized: true
      }),
      idempotencyKey,
      deadlineAt: new Date(Date.now() + 60_000).toISOString()
    })
  });
}

async function runBrokerProbe(target, root, source, {
  kind,
  resources = adversarialResources(),
  outputs,
  idempotencyKey,
  cancelAfterMs = 0,
  readResult = false
} = {}) {
  const definition = brokerRequest(source, { kind, resources, outputs, idempotencyKey });
  const profile = Object.freeze({
    id: ADVERSARIAL_PROFILE,
    policyRevision: ADVERSARIAL_POLICY_REVISION,
    workloads: Object.freeze({
      [kind]: Object.freeze({
        runtimeKind: "oci",
        image: PINNED_IMAGE,
        command: Object.freeze(["node"]),
        artifactDigests: Object.freeze([definition.sourceDigest]),
        entryPoint: "probe.mjs"
      })
    }),
    capabilities: Object.freeze({
      filesystem: Object.freeze(["input:read", "output:write"]),
      network: Object.freeze([]),
      tools: Object.freeze([]),
      secretRefs: Object.freeze([]),
      clock: false,
      randomness: false,
      subprocesses: 0
    }),
    resourceLimits: resources,
    requiresApproval: false,
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  });
  const resolver = Object.freeze({
    async resolve() {
      return Object.freeze({ descriptor: brokerDescriptor(target), backend: target.backend });
    },
    validate(resolution) {
      return resolution?.descriptor?.id === target.id && resolution?.backend === target.backend;
    }
  });
  const broker = createSandboxExecutionBroker({
    configuration: Object.freeze({
      enabled: true,
      providerMode: "explicit",
      providerId: target.id,
      profileId: ADVERSARIAL_PROFILE,
      policyRevision: ADVERSARIAL_POLICY_REVISION,
      allowedProviderClasses: Object.freeze([target.providerClass]),
      receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
    }),
    profiles: Object.freeze({ [ADVERSARIAL_PROFILE]: profile }),
    providerResolver: resolver,
    userDataPath: path.join(root, `broker-${crypto.randomUUID()}`)
  });
  const controller = new AbortController();
  let cancellationTimer = null;
  if (cancelAfterMs > 0) {
    cancellationTimer = setTimeout(() => controller.abort(), cancelAfterMs);
    cancellationTimer.unref?.();
  }
  try {
    const receipt = await broker.execute(definition.request, {
      signal: controller.signal,
      currentGovernance: Object.freeze({
        grantRef: "oci-conformance-grant",
        approvalRef: "",
        approvalBindingDigest: "",
        approvalSourceDigest: "",
        approvalRequestDigest: "",
        approvalExpiresAt: "",
        authorizationContextDigest: crypto.createHash("sha256").update("oci-conformance-authorization").digest("hex"),
        riskDecisionRef: "oci-conformance-risk",
        policyRevision: ADVERSARIAL_POLICY_REVISION,
        authorized: true,
        current: true,
        revoked: false
      }),
      resolveInput: async () => Object.freeze({
        digest: definition.inputDigest,
        files: Object.freeze([{
          path: "probe.mjs",
          digest: definition.sourceDigest,
          content: source
        }])
      })
    });
    let result = null;
    if (readResult && receipt.runtimeState === "succeeded" && receipt.outputHandle) {
      const output = broker.resolveQuarantinedOutput(receipt.outputHandle);
      result = JSON.parse(await output.readFile("result.json"));
      await broker.disposeOutput(receipt.outputHandle, "rejected", {
        owningOperationReceiptDigest: crypto.createHash("sha256")
          .update(`oci-conformance-disposition:${receipt.runId}`)
          .digest("hex")
      });
    }
    return Object.freeze({ receipt, result });
  } finally {
    if (cancellationTimer) clearTimeout(cancellationTimer);
    await broker.close();
  }
}

async function prepareDirectContext(root, runId, source, {
  resources = adversarialResources(),
  capabilities = {}
} = {}) {
  const runRoot = path.join(root, runId);
  const inputRoot = path.join(runRoot, "input");
  const inputDirectory = path.join(inputRoot, "0");
  const scratchRoot = path.join(runRoot, "scratch");
  const outputRoot = path.join(runRoot, "output");
  await privateDirectory(inputDirectory);
  await privateDirectory(scratchRoot);
  await privateDirectory(outputRoot);
  await fs.writeFile(path.join(inputDirectory, "probe.mjs"), source, { mode: 0o444 });
  await fs.chmod(inputDirectory, 0o555);
  await fs.chmod(inputRoot, 0o555);
  const controller = new AbortController();
  return Object.freeze({
    controller,
    context: Object.freeze({
      runId,
      request: Object.freeze({
        artifact: Object.freeze({ entryPoint: "probe.mjs" }),
        invocation: Object.freeze({ workingDirectory: "input/0", args: Object.freeze([]) }),
        resources,
        outputs: Object.freeze({ maxBytes: 64 * 1024, maxFiles: 4 })
      }),
      policy: adversarialPolicy(capabilities),
      paths: Object.freeze({ inputRoot, scratchRoot, outputRoot }),
      signal: controller.signal
    })
  });
}

async function forbiddenCapabilityDenied(target, root, capabilityName, value) {
  const runId = `forbidden-${capabilityName}-${crypto.randomUUID()}`;
  const prepared = await prepareDirectContext(root, runId, "", {
    capabilities: { [capabilityName]: Object.freeze([value]) }
  });
  let denied = false;
  try {
    await target.backend.run(prepared.context);
  } catch (error) {
    denied = error?.code === SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED;
  }
  const cleanup = await target.backend.cleanup(prepared.context);
  return denied && cleanup.destroyed === true;
}

async function waitForFile(targetPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return false;
}

async function attemptedProbe(operation) {
  try {
    return await operation();
  } catch {
    return null;
  }
}

export async function runOciAdversarialConformanceMatrix(target, root) {
  const resourceProbe = await attemptedProbe(() => runBrokerProbe(target, root, RESOURCE_PROBE_SOURCE, {
    kind: "resource_probe",
    resources: adversarialResources({ wallTimeMs: 1_000, cpuMillis: 250 }),
    idempotencyKey: `resource-${crypto.randomUUID()}`,
    readResult: true
  }));
  const cancellationKey = `cancel-${crypto.randomUUID()}`;
  const cancelled = await attemptedProbe(() => runBrokerProbe(target, root, LONG_RUNNING_SOURCE, {
    kind: "cancellation_probe",
    resources: adversarialResources({ wallTimeMs: 8_000, cpuMillis: 1_000 }),
    idempotencyKey: cancellationKey,
    cancelAfterMs: 500
  }));
  const cancelledReplay = await attemptedProbe(() => runBrokerProbe(target, root, LONG_RUNNING_SOURCE, {
    kind: "cancellation_probe",
    resources: adversarialResources({ wallTimeMs: 8_000, cpuMillis: 1_000 }),
    idempotencyKey: cancellationKey,
    cancelAfterMs: 500
  }));
  const timedOut = await attemptedProbe(() => runBrokerProbe(target, root, LONG_RUNNING_SOURCE, {
    kind: "timeout_probe",
    resources: adversarialResources({ wallTimeMs: 350, cpuMillis: 100 }),
    idempotencyKey: `timeout-${crypto.randomUUID()}`
  }));
  const outputOverflow = await attemptedProbe(() => runBrokerProbe(target, root, OUTPUT_OVERFLOW_SOURCE, {
    kind: "output_probe",
    resources: adversarialResources(),
    outputs: Object.freeze({
      schema: "oci-output-limit",
      maxFiles: 1,
      maxBytes: 32,
      allowedTypes: Object.freeze(["json"])
    }),
    idempotencyKey: `output-${crypto.randomUUID()}`
  }));
  const logOverflow = await attemptedProbe(() => runBrokerProbe(target, root, LOG_OVERFLOW_SOURCE, {
    kind: "log_probe",
    resources: adversarialResources({ logBytes: 1_024 }),
    idempotencyKey: `log-${crypto.randomUUID()}`
  }));
  const subprocessProbe = await attemptedProbe(() => runBrokerProbe(target, root, SUBPROCESS_DENIAL_SOURCE, {
    kind: "subprocess_probe",
    resources: adversarialResources({ processes: 64 }),
    idempotencyKey: `subprocess-${crypto.randomUUID()}`,
    readResult: true
  }));
  const forbiddenNetwork = await attemptedProbe(
    () => forbiddenCapabilityDenied(target, root, "network", "https")
  );
  const forbiddenSecret = await attemptedProbe(
    () => forbiddenCapabilityDenied(target, root, "secretRefs", "secret-ref")
  );
  const forbiddenTool = await attemptedProbe(
    () => forbiddenCapabilityDenied(target, root, "tools", "tool-ref")
  );

  const closeRun = await attemptedProbe(() => prepareDirectContext(
    root,
    `close-${crypto.randomUUID()}`,
    READY_LONG_RUNNING_SOURCE,
    { resources: adversarialResources({ wallTimeMs: 8_000, cpuMillis: 1_000 }) }
  ));
  let backendCloseReapedActiveRun = false;
  if (closeRun) {
    const closeRunPromise = target.backend.run(closeRun.context);
    void closeRunPromise.catch(() => {});
    const closeRunReady = await waitForFile(path.join(closeRun.context.paths.outputRoot, "ready"));
    if (closeRunReady) {
      const closeResult = await Promise.allSettled([target.backend.close(), closeRunPromise]);
      const cleanup = await target.backend.cleanup(closeRun.context);
      backendCloseReapedActiveRun =
        closeResult[0].status === "fulfilled" &&
        closeResult[1].status === "rejected" &&
        cleanup.destroyed === true;
    } else {
      closeRun.controller.abort();
      await Promise.allSettled([closeRunPromise]);
      await target.backend.cleanup(closeRun.context).catch(() => {});
    }
  }

  return Object.freeze({
    cancellationObserved:
      cancelled?.receipt?.runtimeState === "cancelled" &&
      cancelled.receipt.reasonCode === SANDBOX_DENIAL_REASONS.CANCELLED,
    cancellationCleanupDestroyed: cancelled?.receipt?.cleanupState === "destroyed",
    cancelledRunIdentityReusable:
      cancelledReplay?.receipt?.runtimeState === "cancelled" &&
      cancelledReplay.receipt.cleanupState === "destroyed",
    timeoutObserved:
      timedOut?.receipt?.runtimeState === "timed_out" &&
      timedOut.receipt.reasonCode === SANDBOX_DENIAL_REASONS.TIMED_OUT,
    timeoutCleanupDestroyed: timedOut?.receipt?.cleanupState === "destroyed",
    pidLimitEnforced: resourceProbe?.receipt?.runtimeState === "succeeded" && resourceProbe.result?.pidsBounded === true,
    fileDescriptorLimitEnforced:
      resourceProbe?.receipt?.runtimeState === "succeeded" && resourceProbe.result?.fileDescriptorsBounded === true,
    memoryLimitEnforced:
      resourceProbe?.receipt?.runtimeState === "succeeded" && resourceProbe.result?.memoryBounded === true,
    cpuLimitEnforced: resourceProbe?.receipt?.runtimeState === "succeeded" && resourceProbe.result?.cpuBounded === true,
    outputLimitEnforced:
      outputOverflow?.receipt?.reasonCode === SANDBOX_DENIAL_REASONS.OUTPUT_INVALID &&
      outputOverflow.receipt.cleanupState === "destroyed" &&
      outputOverflow.receipt.outputDisposition !== "quarantined",
    logLimitEnforced:
      logOverflow?.receipt?.reasonCode === SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED &&
      logOverflow.receipt.cleanupState === "destroyed" &&
      logOverflow.receipt.resourceTotals.logBytes <= 1_024,
    subprocessProbeCompleted: subprocessProbe?.receipt?.runtimeState === "succeeded",
    subprocessZeroEnforced: subprocessProbe?.result?.subprocessDenied === true,
    forbiddenNetworkDenied: forbiddenNetwork === true,
    forbiddenSecretDenied: forbiddenSecret === true,
    forbiddenToolDenied: forbiddenTool === true,
    backendCloseReapedActiveRun
  });
}

export function createOciProviderConformanceReceipt({
  target,
  checks,
  generatedAt = new Date(),
  policyRevision = POLICY_REVISION,
  runtimeProfile = RUNTIME_PROFILE,
  receiptRequirement = CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
} = {}) {
  const checkValues = Object.values(checks || {});
  return createSandboxProviderConformanceReceipt({
    schemaVersion: SANDBOX_PROVIDER_CONFORMANCE_SCHEMA,
    providerId: target?.id,
    providerClass: target?.providerClass,
    status: checkValues.length > 0 && checkValues.every(Boolean) ? "passed" : "failed",
    policyRevision,
    receiptRequirement,
    runtimeProfile,
    isolationClass: target?.isolationClass,
    serviceIdentityRef: target?.serviceIdentityRef,
    executableIdentityDigest: target?.executableIdentityDigest,
    checkDigest: sandboxDigest(checks || {}),
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString()
  });
}

async function receiptResolverState({ target, receipt, policyRevision, runtimeProfile, receiptRequirement, now }) {
  const adapter = Object.freeze({
    id: target.id,
    providerClass: target.providerClass,
    async probe() {
      return Object.freeze({
        ...brokerDescriptor(target),
        conformanceReceipt: receipt
      });
    },
    async createBackend() {
      return target.backend;
    }
  });
  const resolver = createTrustedSandboxProviderResolver({
    configuration: Object.freeze({
      enabled: true,
      providerMode: "explicit",
      providerId: target.id,
      profileId: runtimeProfile,
      policyRevision,
      allowedProviderClasses: Object.freeze([target.providerClass]),
      receiptRequirement
    }),
    adapters: Object.freeze([adapter]),
    now,
    ttlMs: 1
  });
  try {
    return await resolver.resolve();
  } catch {
    return null;
  }
}

export async function verifyOciReceiptLifecycle({
  target,
  root,
  generatedAt,
  policyRevision,
  runtimeProfile,
  receiptRequirement
}) {
  const receipt = createOciProviderConformanceReceipt({
    target,
    checks: { lifecycleFixture: true },
    generatedAt,
    policyRevision,
    runtimeProfile,
    receiptRequirement
  });
  const freshResolution = await receiptResolverState({
    target,
    receipt,
    policyRevision,
    runtimeProfile,
    receiptRequirement,
    now: () => new Date(generatedAt.getTime() + 1)
  });
  const staleResolution = await receiptResolverState({
    target,
    receipt,
    policyRevision,
    runtimeProfile,
    receiptRequirement,
    now: () => new Date(Date.parse(receipt.expiresAt) + 1)
  });
  const revokedResolution = await receiptResolverState({
    target,
    receipt: null,
    policyRevision,
    runtimeProfile,
    receiptRequirement,
    now: () => new Date(generatedAt.getTime() + 1)
  });
  const missingResolver = createTrustedSandboxProviderResolver({
    configuration: Object.freeze({
      enabled: true,
      providerMode: "explicit",
      providerId: target.id,
      profileId: runtimeProfile,
      policyRevision,
      allowedProviderClasses: Object.freeze([target.providerClass]),
      receiptRequirement
    }),
    adapters: Object.freeze([]),
    now: () => new Date(generatedAt.getTime() + 1),
    ttlMs: 1
  });
  const missingResolution = await missingResolver.resolve();

  const receiptStateRoot = path.join(root, "receipt-lifecycle");
  await writeTrustedSandboxProviderReceipts({
    userDataPath: receiptStateRoot,
    receipts: { [target.id]: receipt }
  });
  await revokeTrustedOciConformanceReceipt({ userDataPath: receiptStateRoot, providerId: target.id });
  const revokedState = loadTrustedSandboxProviderReceipts({ userDataPath: receiptStateRoot });

  return Object.freeze({
    freshReceiptAccepted: freshResolution?.descriptor?.id === target.id,
    staleReceiptRejected: staleResolution === null,
    revokedReceiptRejected: revokedResolution === null,
    explicitReceiptRevocationRemovesState: !Object.hasOwn(revokedState, target.id),
    backendRemovalFailsClosed: missingResolution === null
  });
}

export async function runExecutionSandboxOciConformance({
  reportPath = REPORT_PATH,
  writeReport = true,
  userDataPath = "",
  policyRevision = POLICY_REVISION,
  runtimeProfile = RUNTIME_PROFILE,
  receiptRequirement = CONTROLLED_SANDBOX_FINAL_RECEIPT_ID,
  targetFactory = createOciBackendConformanceTarget,
  preflightRunner = runOciConformancePreflight,
  probeRunner = runProbe,
  adversarialRunner = runOciAdversarialConformanceMatrix,
  receiptLifecycleVerifier = verifyOciReceiptLifecycle,
  now = () => new Date()
} = {}) {
  const target = await targetFactory();
  if (!target) {
    const error = new Error("No trusted OCI conformance target is installed.");
    error.code = "execution_sandbox_oci_target_missing";
    throw error;
  }
  let root = "";
  let report;
  try {
    await preflightRunner(target);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-sandbox-oci-conformance-"));
    const probeResults = await Promise.allSettled([
      probeRunner(target, root, `conformance-${crypto.randomUUID()}`),
      probeRunner(target, root, `conformance-${crypto.randomUUID()}`)
    ]);
    const first = probeResults[0].status === "fulfilled" ? probeResults[0].value : null;
    const second = probeResults[1].status === "fulfilled" ? probeResults[1].value : null;
    const probeFailures = probeResults
      .filter((entry) => entry.status === "rejected")
      .map((entry) => boundedProbeFailure(entry.reason));
    const generatedAt = now();
    const receiptLifecycleChecks = await receiptLifecycleVerifier({
      target,
      root,
      generatedAt,
      policyRevision,
      runtimeProfile,
      receiptRequirement
    });
    const adversarialChecks = await adversarialRunner(target, root);
    const checks = Object.freeze({
      executionSucceeded: first?.execution?.status === "succeeded" && second?.execution?.status === "succeeded",
      nonRootIdentity: first?.result?.nonRootIdentity === true && second?.result?.nonRootIdentity === true,
      immutableInputReadable: first?.result?.immutableInputReadable === true && second?.result?.immutableInputReadable === true,
      immutableInputWriteDenied: first?.result?.immutableInputWriteDenied === true && second?.result?.immutableInputWriteDenied === true,
      rootFilesystemWriteDenied: first?.result?.rootFilesystemWriteDenied === true && second?.result?.rootFilesystemWriteDenied === true,
      capabilitiesDropped: first?.result?.capabilitiesDropped === true && second?.result?.capabilitiesDropped === true,
      noNewPrivileges: first?.result?.noNewPrivileges === true && second?.result?.noNewPrivileges === true,
      seccompFilterActive: first?.result?.seccompFilterActive === true && second?.result?.seccompFilterActive === true,
      deviceNodesRestricted: first?.result?.deviceNodesRestricted === true && second?.result?.deviceNodesRestricted === true,
      networkDenied: first?.result?.networkDenied === true && second?.result?.networkDenied === true,
      sensitiveEnvironmentAbsent: first?.result?.sensitiveEnvironmentAbsent === true && second?.result?.sensitiveEnvironmentAbsent === true,
      containerControlSocketAbsent: first?.result?.containerControlSocketAbsent === true && second?.result?.containerControlSocketAbsent === true,
      isolatedRuntimeNamespaces: ["ipc", "mount", "network", "pid", "uts"].every((namespace) => {
        const firstIdentity = String(first?.result?.isolationNamespaces?.[namespace] || "");
        const secondIdentity = String(second?.result?.isolationNamespaces?.[namespace] || "");
        return Boolean(firstIdentity) && Boolean(secondIdentity) && firstIdentity !== secondIdentity;
      }),
      scratchQuotaBounded: first?.result?.scratchQuotaBounded === true && second?.result?.scratchQuotaBounded === true,
      privateOutputOwned: first?.result?.privateOutputOwned === true && second?.result?.privateOutputOwned === true,
      independentInstancesDestroyed: first?.cleanup?.destroyed === true && second?.cleanup?.destroyed === true,
      linuxRuntime: first?.result?.linuxRuntime === true && second?.result?.linuxRuntime === true,
      ...receiptLifecycleChecks,
      ...adversarialChecks
    });
    const productionBackendConformance = Object.values(checks).every(Boolean);
    const conformanceReceipt = createOciProviderConformanceReceipt({
      target,
      checks,
      generatedAt,
      policyRevision,
      runtimeProfile,
      receiptRequirement
    });
    report = Object.freeze({
      schemaVersion: REPORT_SCHEMA,
      verifier: VERIFIER,
      generatedAt: generatedAt.toISOString(),
      sourceContext: createSourceEvidenceContext(REPO_ROOT, {
        verifier: VERIFIER,
        commandId: "controlled-execution-sandbox"
      }),
      productionBackendConformance,
      summary: Object.freeze({
        productionBackendConformance,
        checkCount: Object.keys(checks).length,
        failedCheckCount: Object.values(checks).filter((value) => !value).length,
        reportLeakScan: true
      }),
      checks,
      probeFailures,
      conformanceReceipt
    });
    if (String(userDataPath || "").trim()) {
      const receipts = {
        ...loadTrustedSandboxProviderReceipts({ userDataPath })
      };
      if (productionBackendConformance) receipts[target.id] = conformanceReceipt;
      else delete receipts[target.id];
      await writeTrustedSandboxProviderReceipts({ userDataPath, receipts });
    }
    if (writeReport) {
      const absolutePath = path.resolve(reportPath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } catch (error) {
    if (String(userDataPath || "").trim() && target?.id) {
      try {
        await revokeTrustedOciConformanceReceipt({ userDataPath, providerId: target.id });
      } catch {
        const revocationError = new Error("The OCI conformance receipt could not be revoked safely.");
        revocationError.code = "execution_sandbox_oci_receipt_revocation_failed";
        throw revocationError;
      }
    }
    throw error;
  } finally {
    await target.backend.close().catch(() => {});
    if (root) await removePrivateTree(root);
  }
}

export async function runExecutionSandboxOciConformanceCli({
  argv = [],
  conformanceRunner = runExecutionSandboxOciConformance,
  receiptRevoker = revokeTrustedOciConformanceReceipt,
  conformanceOptions = {}
} = {}) {
  const options = parseExecutionSandboxOciConformanceArguments(argv);
  if (options.action === "revoke") {
    await receiptRevoker({
      userDataPath: options.userDataPath,
      providerId: options.providerId
    });
    return Object.freeze({ action: "revoke", receiptState: "revoked" });
  }
  const report = await conformanceRunner({
    ...conformanceOptions,
    userDataPath: options.userDataPath,
    policyRevision: options.policyRevision,
    runtimeProfile: options.runtimeProfile,
    receiptRequirement: CONTROLLED_SANDBOX_FINAL_RECEIPT_ID
  });
  if (!report.productionBackendConformance) {
    const error = new Error("OCI provider conformance did not pass.");
    error.code = "execution_sandbox_oci_conformance_failed";
    throw error;
  }
  return Object.freeze({
    action: "provision",
    receiptState: "provisioned",
    report
  });
}

const invokedDirectly = process.argv[1] &&
  path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runExecutionSandboxOciConformanceCli({ argv: process.argv.slice(2) }).then((result) => {
    if (result.action === "revoke") {
      console.log("[execution-sandbox-oci-conformance] receipt=revoked");
      return;
    }
    console.log(`[execution-sandbox-oci-conformance] passed=true checks=${result.report.summary.checkCount} receipt=provisioned`);
  }).catch((error) => {
    console.error(`[execution-sandbox-oci-conformance] failed code=${publicErrorCode(error)}`);
    process.exitCode = ["execution_sandbox_oci_target_missing", "execution_sandbox_oci_daemon_unavailable"].includes(error?.code) ? 2 : 1;
  });
}
