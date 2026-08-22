import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { SANDBOX_DENIAL_REASONS } from "#meshrix/foundation/execution-sandbox/contracts";
import type { SandboxExecutionRequest } from "#meshrix/foundation/execution-sandbox/contracts";

interface DirectoryOwnership { uid: number; gid: number; label: string; writable: boolean }
interface CommandOptions { signal?: AbortSignal | null; maxBytes?: number; allowFailure?: boolean; captureStdout?: boolean; timeoutMs?: number }
interface CommandResult { code: number; signal: string; bytes: number; stdout: string }
type CommandRunner = (binary: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
interface SandboxPolicy {
  capabilities: { network: readonly string[]; secretRefs: readonly string[]; tools: readonly string[]; subprocesses: number };
  workload: { command: readonly string[]; image: string };
}
interface SandboxPaths { inputRoot: string; outputRoot: string }
interface BackendContext {
  runId: string;
  request: SandboxExecutionRequest;
  policy: SandboxPolicy;
  paths: SandboxPaths;
  signal?: AbortSignal;
}
interface OciBackendOptions {
  id?: string; binary?: string; engine?: string; runtimeClass?: string; healthy?: boolean;
  hostUid?: number; hostGid?: number; commandRunner?: CommandRunner;
}

const ENFORCED_RESTRICTIONS: readonly string[] = Object.freeze([
  "filesystem",
  "process",
  "network",
  "environment",
  "credentials",
  "resources",
  "output",
  "cleanup",
  "cross-trust-domain"
]);
const OCI_CONTROL_COMMAND_TIMEOUT_MS = 30_000;

function requiredText(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.includes("\0")) throw new TypeError(`${label} is required.`);
  return normalized;
}

function immutableImage(value: unknown): string {
  const image = requiredText(value, "OCI sandbox image");
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error("OCI sandbox images must use an immutable SHA-256 digest.");
  }
  return image;
}

function containerIdentity(runId: unknown, backendNonce: string) {
  const normalizedRunId = requiredText(runId, "OCI sandbox run id");
  const digest = crypto.createHash("sha256")
    .update(`${backendNonce}\0${normalizedRunId}`, "utf8")
    .digest("hex");
  return Object.freeze({
    name: `meshrix-sandbox-${digest.slice(0, 32)}`,
    digest
  });
}

function boundedBufferLimit(value: unknown, fallback = 64 * 1024): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function classifyOciCommandFailure(stderr: unknown, stdout: unknown = "", exitCode: unknown = null): string {
  const message = `${String(stderr || "")}\n${String(stdout || "")}`.toLowerCase();
  if (/no space left on device|disk quota exceeded/u.test(message)) return "oci_storage_exhausted";
  if (/invalid reference format/u.test(message)) return "oci_image_reference_invalid";
  if (/no such image|unable to find image|image .* not found/u.test(message)) return "oci_image_unavailable";
  if (/container name .* already in use|conflict.*container name/u.test(message)) return "oci_name_conflict";
  if (/cannot connect to .*daemon|is the .* daemon running|connection refused/u.test(message)) return "oci_daemon_unavailable";
  if (/context canceled|context deadline exceeded|request canceled|request cancelled/u.test(message)) return "oci_daemon_request_expired";
  if (/resource temporarily unavailable|temporarily unavailable|try again/u.test(message)) return "oci_runtime_busy";
  if (/failed to create task|failed to create shim|oci runtime create failed|runc create failed/u.test(message)) return "oci_runtime_initialization_failed";
  if (/failed to set up container networking|network[^\n]{0,96}failed/u.test(message)) return "oci_network_setup_failed";
  if (/cgroup|cgroupns/u.test(message)) return "oci_cgroup_rejected";
  if (/seccomp/u.test(message)) return "oci_seccomp_rejected";
  if (/ulimit/u.test(message)) return "oci_ulimit_rejected";
  if (/tmpfs/u.test(message)) return "oci_tmpfs_rejected";
  if (/unknown flag|invalid argument|not supported|unsupported/u.test(message)) return "oci_option_unsupported";
  if (/invalid mount config|mount .* denied|bind source path does not exist/u.test(message)) return "oci_mount_rejected";
  if (/minimum memory limit|invalid cpu|invalid pids|resource limit/u.test(message)) return "oci_resource_limit_rejected";
  if (/permission denied|operation not permitted|access is denied/u.test(message)) return "oci_permission_denied";
  if (/error response from daemon/u.test(message)) return "oci_daemon_rejected";
  if (/failed to create|error creating|cannot create/u.test(message)) return "oci_create_rejected";
  if (Number(exitCode) === 125) return "oci_cli_invocation_rejected";
  return "oci_command_rejected";
}

function runtimeCreateArguments(engine: unknown, runtimeClass: unknown): string[] {
  const selectedEngine = requiredText(engine, "OCI sandbox backend engine");
  const selectedRuntimeClass = requiredText(runtimeClass, "OCI sandbox runtime class");
  if (selectedEngine === "docker" && selectedRuntimeClass === "runc") {
    return [];
  }
  return ["--runtime", selectedRuntimeClass];
}

async function assertOwnedDirectory(directoryPath: string, { uid, gid, label, writable }: DirectoryOwnership): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  const mode = stat.mode & 0o777;
  const invalidMode = writable === true
    ? (mode & 0o077) !== 0
    : (mode & 0o222) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid || invalidMode) {
    throw Object.assign(new Error(`${label} is not an owned directory.`), {
      code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED
    });
  }
}

function runCommand(binary: string, args: string[], {
  signal = null,
  maxBytes = 64 * 1024,
  allowFailure = false,
  captureStdout = false,
  timeoutMs = 0
}: CommandOptions = {}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let deadlineExceeded = false;
    let bytes = 0;
    let stdout = "";
    let classifierStdout = "";
    let stderr = "";
    let deadline: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    const finish = (error: unknown, value?: CommandResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("OCI sandbox command completed without a result."));
    };
    const abort = ()  => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
      deadline = setTimeout(() => {
        deadlineExceeded = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      deadline.unref?.();
    }
    const consume = (chunk: Buffer, capture = false) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
      }
      if (capture && bytes <= maxBytes) stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(classifierStdout, "utf8") < 4 * 1024) classifierStdout += chunk.toString("utf8");
      consume(chunk, captureStdout);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < 4 * 1024) stderr += chunk.toString("utf8");
      consume(chunk);
    });
    child.once("error", (error: Error) => finish(error));
    child.once("close", (code: number | null, childSignal: NodeJS.Signals | null) => {
      const failureStage = ["create", "start", "inspect"].includes(String(args[0] || ""))
        ? String(args[0])
        : "command";
      if (deadlineExceeded) {
        finish(Object.assign(new Error(`OCI sandbox backend ${failureStage} exceeded its command deadline.`), {
          code: SANDBOX_DENIAL_REASONS.TIMED_OUT,
          failureStage: `oci_${failureStage}_failed`,
          failureReason: "oci_command_deadline_exceeded"
        }));
        return;
      }
      if (signal?.aborted) {
        finish(Object.assign(new Error("OCI sandbox execution was cancelled."), {
          code: signal.reason === SANDBOX_DENIAL_REASONS.TIMED_OUT
            ? SANDBOX_DENIAL_REASONS.TIMED_OUT
            : SANDBOX_DENIAL_REASONS.CANCELLED,
          failureStage: `oci_${failureStage}_failed`,
          failureReason: signal.reason === SANDBOX_DENIAL_REASONS.TIMED_OUT
            ? "oci_command_deadline_exceeded"
            : "oci_command_cancelled"
        }));
        return;
      }
      if (bytes > maxBytes) {
        finish(Object.assign(new Error("OCI sandbox log budget was exceeded."), {
          code: SANDBOX_DENIAL_REASONS.LOG_BUDGET_EXCEEDED,
          outputBytes: maxBytes
        }));
        return;
      }
      if (code !== 0 && !allowFailure) {
        finish(Object.assign(new Error(`OCI sandbox backend ${failureStage} failed.`), {
          code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
          failureStage: `oci_${failureStage}_failed`,
          failureReason: classifyOciCommandFailure(stderr, classifierStdout, code),
          exitCode: code,
          signal: childSignal || ""
        }));
        return;
      }
      finish(null, {
        code: Number(code || 0),
        signal: childSignal || "",
        bytes,
        stdout: captureStdout ? stdout : ""
      });
    });
  });
}

export function createOciSandboxBackend({
  id,
  binary,
  engine,
  runtimeClass,
  healthy = true,
  hostUid = process.getuid?.(),
  hostGid = process.getgid?.(),
  commandRunner = runCommand
}: OciBackendOptions = {}) {
  const backendId = requiredText(id, "OCI sandbox backend id");
  const executable = requiredText(binary, "OCI sandbox backend binary");
  const selectedEngine = requiredText(engine, "OCI sandbox backend engine");
  const selectedRuntimeClass = requiredText(runtimeClass, "OCI sandbox runtime class");
  if (!["docker", "podman"].includes(selectedEngine)) {
    throw new Error("OCI sandbox backend engine must be docker or podman.");
  }
  const runtimeUid = Number(hostUid);
  const runtimeGid = Number(hostGid);
  if (!Number.isSafeInteger(runtimeUid) || runtimeUid <= 0 || !Number.isSafeInteger(runtimeGid) || runtimeGid < 0) {
    throw new Error("OCI sandbox backend requires a non-root host process identity.");
  }
  if (typeof commandRunner !== "function") throw new TypeError("OCI sandbox command runner is required.");
  const containers = new Map<string, string>();
  const backendNonce = crypto.randomUUID();
  let createQueue: Promise<void> = Promise.resolve();
  let enabled = healthy === true;

  async function createContainer(args: string[], options: CommandOptions): Promise<CommandResult> {
    const previous = createQueue;
    let release: () => void = () => {};
    createQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await commandRunner(executable, args, options);
    } finally {
      release();
    }
  }

  async function descriptor()  {
    if (!enabled) {
      return Object.freeze({ id: backendId, healthy: false, enforcedRestrictions: ENFORCED_RESTRICTIONS });
    }
    try {
      await commandRunner(executable, ["version", "--format", "{{json .}}"], {
        maxBytes: 16 * 1024,
        timeoutMs: OCI_CONTROL_COMMAND_TIMEOUT_MS
      });
      return Object.freeze({
        id: backendId,
        kind: "hardened-oci",
        production: true,
        healthy: true,
        runtimeClass: selectedRuntimeClass,
        enforcedRestrictions: ENFORCED_RESTRICTIONS
      });
    } catch {
      return Object.freeze({
        id: backendId,
        kind: "hardened-oci",
        production: true,
        healthy: false,
        runtimeClass: selectedRuntimeClass,
        enforcedRestrictions: ENFORCED_RESTRICTIONS
      });
    }
  }

  async function run(context: BackendContext) {
    const { runId, request, policy, paths, signal } = context;
    if (policy.capabilities.network.length > 0 || policy.capabilities.secretRefs.length > 0 || policy.capabilities.tools.length > 0) {
      throw Object.assign(new Error("This OCI backend does not expose network, secret, or tool brokers."), {
        code: SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED
      });
    }
    if (policy.capabilities.subprocesses !== 0) {
      throw Object.assign(new Error("This OCI backend only supports workloads that deny subprocess creation."), {
        code: SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED
      });
    }
    const runtimeCommand = policy.workload.command;
    const nodeRuntimeArguments = runtimeCommand.length === 1 && runtimeCommand[0] === "node"
      ? []
      : runtimeCommand.length === 3 &&
          runtimeCommand[0] === "node" &&
          runtimeCommand[1] === "-e" &&
          typeof runtimeCommand[2] === "string" &&
          runtimeCommand[2].length > 0 &&
          Buffer.byteLength(runtimeCommand[2], "utf8") <= 64 * 1024
        ? runtimeCommand.slice(1)
        : null;
    if (nodeRuntimeArguments === null) {
      throw Object.assign(new Error("This OCI backend requires the governed Node runtime profile."), {
        code: SANDBOX_DENIAL_REASONS.POLICY_UNSUPPORTED
      });
    }
    if (containers.has(runId)) {
      throw Object.assign(new Error("OCI sandbox run is already active."), {
        code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED
      });
    }
    const identity = containerIdentity(runId, backendNonce);
    const name = identity.name;
    const image = immutableImage(policy.workload.image);
    const cpus = Math.max(0.01, Math.min(64, request.resources.cpuMillis / request.resources.wallTimeMs));
    await assertOwnedDirectory(paths.inputRoot, {
      uid: runtimeUid,
      gid: runtimeGid,
      label: "OCI sandbox input root",
      writable: false
    });
    await assertOwnedDirectory(paths.outputRoot, {
      uid: runtimeUid,
      gid: runtimeGid,
      label: "OCI sandbox output root",
      writable: true
    });
    await fs.chmod(paths.outputRoot, 0o700);
    const args = [
      "create",
      "--name", name,
      "--hostname", "sandbox",
      "--label", "meshrix.sandbox.managed=true",
      "--label", `meshrix.sandbox.run-digest=${identity.digest}`,
      "--pull", "never",
      ...runtimeCreateArguments(selectedEngine, selectedRuntimeClass),
      "--network", "none",
      "--ipc", "none",
      "--cgroupns", "private",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(request.resources.processes),
      "--memory", String(request.resources.memoryBytes),
      "--memory-swap", String(request.resources.memoryBytes),
      "--cpus", cpus.toFixed(3),
      "--ulimit", "core=0:0",
      "--ulimit", `nofile=${request.resources.fileDescriptors}:${request.resources.fileDescriptors}`,
      "--mount", `type=bind,src=${paths.inputRoot},dst=/sandbox/input,readonly`,
      "--mount", `type=bind,src=${paths.outputRoot},dst=/sandbox/output`,
      "--tmpfs", `/sandbox/scratch:rw,noexec,nosuid,nodev,size=${request.resources.diskBytes},nr_inodes=${request.resources.inodes},mode=0700,uid=${runtimeUid},gid=${runtimeGid}`,
      "--workdir", `/sandbox/${request.invocation.workingDirectory}`,
      "--user", `${runtimeUid}:${runtimeGid}`,
      image,
      "node",
      "--permission",
      "--allow-fs-read=*",
      "--allow-fs-write=/sandbox/output",
      "--allow-fs-write=/sandbox/scratch",
      ...nodeRuntimeArguments,
      request.artifact.entryPoint,
      ...request.invocation.args.map(String)
    ];
    containers.set(runId, name);
    await createContainer(args, {
      signal,
      maxBytes: 16 * 1024,
      timeoutMs: request.resources.wallTimeMs
    });
    const execution = await commandRunner(executable, ["start", "--attach", name], {
      signal,
      maxBytes: boundedBufferLimit(request.resources.logBytes),
      timeoutMs: request.resources.wallTimeMs
    });
    const inspected = await commandRunner(executable, [
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      name
    ], {
      signal,
      maxBytes: 128,
      captureStdout: true,
      timeoutMs: request.resources.wallTimeMs
    });
    const workloadExitCode = Number.parseInt(inspected.stdout.trim(), 10);
    if (!Number.isSafeInteger(workloadExitCode) || workloadExitCode !== 0) {
      throw Object.assign(new Error("OCI sandbox workload failed."), {
        code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
        failureStage: "oci_workload_failed",
        exitCode: Number.isSafeInteger(workloadExitCode) ? workloadExitCode : -1
      });
    }
    return Object.freeze({
      status: "succeeded",
      resourceTotals: Object.freeze({ logBytes: execution.bytes })
    });
  }

  async function cancel({ runId }: { runId?: string } = {}) {
    if (!runId) return false;
    const name = containers.get(runId);
    if (!name) return false;
    await commandRunner(executable, ["kill", name], {
      maxBytes: 16 * 1024,
      allowFailure: true,
      timeoutMs: OCI_CONTROL_COMMAND_TIMEOUT_MS
    });
    return true;
  }

  async function cleanup({ runId }: { runId?: string } = {}) {
    if (!runId) return Object.freeze({ destroyed: true });
    const name = containers.get(runId);
    if (!name) return Object.freeze({ destroyed: true });
    const result = await commandRunner(executable, ["rm", "--force", name], {
      maxBytes: 16 * 1024,
      allowFailure: true,
      timeoutMs: OCI_CONTROL_COMMAND_TIMEOUT_MS
    });
    if (result.code === 0) containers.delete(runId);
    return Object.freeze({ destroyed: result.code === 0 });
  }

  async function close()  {
    enabled = false;
    const results = await Promise.allSettled([...containers.entries()].map(async ([runId, name])  => {
      const result = await commandRunner(executable, ["rm", "--force", name], {
        maxBytes: 16 * 1024,
        allowFailure: true,
        timeoutMs: OCI_CONTROL_COMMAND_TIMEOUT_MS
      });
      if (result.code === 0) containers.delete(runId);
      if (result.code !== 0) throw new Error("OCI sandbox container cleanup failed.");
    }));
    if (results.some((entry) => entry.status === "rejected") || containers.size > 0) {
      throw new Error("OCI sandbox backend did not close cleanly.");
    }
  }

  return Object.freeze({ descriptor, run, cancel, cleanup, close });
}
