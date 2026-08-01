import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { SANDBOX_DENIAL_REASONS } from "#meshrix/foundation/execution-sandbox/contracts";

const ENFORCED_RESTRICTIONS: readonly any[] = Object.freeze([
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

function requiredText(value?: any, label?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!normalized || normalized.includes("\0")) throw new TypeError(`${label} is required.`);
  return normalized;
}

function immutableImage(value?: any) : any {
  const image: any = requiredText(value, "OCI sandbox image");
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error("OCI sandbox images must use an immutable SHA-256 digest.");
  }
  return image;
}

function containerIdentity(runId?: any, backendNonce?: any) : any {
  const normalizedRunId: any = requiredText(runId, "OCI sandbox run id");
  const digest: any = crypto.createHash("sha256")
    .update(`${backendNonce}\0${normalizedRunId}`, "utf8")
    .digest("hex");
  return Object.freeze({
    name: `meshrix-sandbox-${digest.slice(0, 32)}`,
    digest
  });
}

function boundedBufferLimit(value?: any, fallback: any = 64 * 1024) : any {
  const number: any = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function runtimeCreateArguments(engine?: any, runtimeClass?: any) : any {
  const selectedEngine: any = requiredText(engine, "OCI sandbox backend engine");
  const selectedRuntimeClass: any = requiredText(runtimeClass, "OCI sandbox runtime class");
  if (selectedEngine === "docker" && selectedRuntimeClass === "runc") {
    return [];
  }
  return ["--runtime", selectedRuntimeClass];
}

async function assertOwnedDirectory(directoryPath: any, { uid, gid, label, writable }: Record<string, any>) : Promise<any> {
  const stat: any = await fs.lstat(directoryPath);
  const mode: any = stat.mode & 0o777;
  const invalidMode: any = writable === true
    ? (mode & 0o077) !== 0
    : (mode & 0o222) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid || invalidMode) {
    throw Object.assign(new Error(`${label} is not an owned directory.`), {
      code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED
    });
  }
}

function runCommand(binary?: any, args?: any, {
  signal = null,
  maxBytes = 64 * 1024,
  allowFailure = false,
  captureStdout = false
}: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    let settled: any = false;
    let bytes: any = 0;
    let stdout: any = "";
    let child: any;
    try {
      child = spawn(binary, args, {
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error: any) {
      reject(error);
      return;
    }
    const finish: any = (error?: any, value?: any) : any => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort: any = () : any => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    const consume: any = (chunk?: any, capture: any = false) : any => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
      }
      if (capture && bytes <= maxBytes) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk?: any) : any => consume(chunk, captureStdout));
    child.stderr.on("data", (chunk?: any) : any => consume(chunk));
    child.once("error", (error?: any) : any => finish(error));
    child.once("close", (code?: any, childSignal?: any) : any => {
      if (signal?.aborted) {
        finish(Object.assign(new Error("OCI sandbox execution was cancelled."), {
          code: SANDBOX_DENIAL_REASONS.CANCELLED
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
        const failureStage: any = ["create", "start", "inspect"].includes(String(args[0] || ""))
          ? String(args[0])
          : "command";
        finish(Object.assign(new Error(`OCI sandbox backend ${failureStage} failed.`), {
          code: SANDBOX_DENIAL_REASONS.RUNTIME_FAILED,
          failureStage: `oci_${failureStage}_failed`,
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
}: Record<string, any> = {}) : any {
  const backendId: any = requiredText(id, "OCI sandbox backend id");
  const executable: any = requiredText(binary, "OCI sandbox backend binary");
  const selectedEngine: any = requiredText(engine, "OCI sandbox backend engine");
  const selectedRuntimeClass: any = requiredText(runtimeClass, "OCI sandbox runtime class");
  if (!["docker", "podman"].includes(selectedEngine)) {
    throw new Error("OCI sandbox backend engine must be docker or podman.");
  }
  if (!Number.isSafeInteger(hostUid) || hostUid <= 0 || !Number.isSafeInteger(hostGid) || hostGid < 0) {
    throw new Error("OCI sandbox backend requires a non-root host process identity.");
  }
  if (typeof commandRunner !== "function") throw new TypeError("OCI sandbox command runner is required.");
  const containers: any = new Map<any, any>();
  const backendNonce: any = crypto.randomUUID();
  let enabled: any = healthy === true;

  async function descriptor() : Promise<any> {
    if (!enabled) {
      return Object.freeze({ id: backendId, healthy: false, enforcedRestrictions: ENFORCED_RESTRICTIONS });
    }
    try {
      await commandRunner(executable, ["version", "--format", "{{json .}}"], { maxBytes: 16 * 1024 });
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

  async function run(context?: any) : Promise<any> {
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
    const runtimeCommand: any = policy.workload.command;
    const nodeRuntimeArguments: any = runtimeCommand.length === 1 && runtimeCommand[0] === "node"
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
    const identity: any = containerIdentity(runId, backendNonce);
    const name: any = identity.name;
    const image: any = immutableImage(policy.workload.image);
    const cpus: any = Math.max(0.01, Math.min(64, request.resources.cpuMillis / request.resources.wallTimeMs));
    await assertOwnedDirectory(paths.inputRoot, {
      uid: hostUid,
      gid: hostGid,
      label: "OCI sandbox input root",
      writable: false
    });
    await assertOwnedDirectory(paths.outputRoot, {
      uid: hostUid,
      gid: hostGid,
      label: "OCI sandbox output root",
      writable: true
    });
    await fs.chmod(paths.outputRoot, 0o700);
    const args: any[] = [
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
      "--tmpfs", `/sandbox/scratch:rw,noexec,nosuid,nodev,size=${request.resources.diskBytes},nr_inodes=${request.resources.inodes},mode=0700,uid=${hostUid},gid=${hostGid}`,
      "--workdir", `/sandbox/${request.invocation.workingDirectory}`,
      "--user", `${hostUid}:${hostGid}`,
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
    await commandRunner(executable, args, { signal, maxBytes: 16 * 1024 });
    const execution: any = await commandRunner(executable, ["start", "--attach", name], {
      signal,
      maxBytes: boundedBufferLimit(request.resources.logBytes)
    });
    const inspected: any = await commandRunner(executable, [
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      name
    ], {
      signal,
      maxBytes: 128,
      captureStdout: true
    });
    const workloadExitCode: any = Number.parseInt(inspected.stdout.trim(), 10);
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

  async function cancel({ runId }: Record<string, any> = {}) : Promise<any> {
    const name: any = containers.get(runId);
    if (!name) return false;
    await commandRunner(executable, ["kill", name], { maxBytes: 16 * 1024, allowFailure: true });
    return true;
  }

  async function cleanup({ runId }: Record<string, any> = {}) : Promise<any> {
    const name: any = containers.get(runId);
    if (!name) return Object.freeze({ destroyed: true });
    const result: any = await commandRunner(executable, ["rm", "--force", name], {
      maxBytes: 16 * 1024,
      allowFailure: true
    });
    if (result.code === 0) containers.delete(runId);
    return Object.freeze({ destroyed: result.code === 0 });
  }

  async function close() : Promise<any> {
    enabled = false;
    const results: any = await Promise.allSettled([...containers.entries()].map(async ([runId, name]: any[]) : Promise<any> => {
      const result: any = await commandRunner(executable, ["rm", "--force", name], {
        maxBytes: 16 * 1024,
        allowFailure: true
      });
      if (result.code === 0) containers.delete(runId);
      if (result.code !== 0) throw new Error("OCI sandbox container cleanup failed.");
    }));
    if (results.some((entry?: any) : any => entry.status === "rejected") || containers.size > 0) {
      throw new Error("OCI sandbox backend did not close cleanly.");
    }
  }

  return Object.freeze({ descriptor, run, cancel, cleanup, close });
}
