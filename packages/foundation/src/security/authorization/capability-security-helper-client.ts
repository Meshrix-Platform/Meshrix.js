import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION = "v0.0.1:risk-control:capability-security-helper-1";

export type CapabilitySecurityRequest = Record<string, unknown>;
export interface CommandCapabilitySecurityClientOptions {
  dataDir?: string; backend?: string; alias?: string; bindingBackend?: string; bindingAlias?: string;
  command?: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number;
}
export interface CommandCapabilitySecurityClient {
  readonly protocolVersion: string; readonly provider: "command-helper"; readonly alias: string;
  issue(input?: CapabilitySecurityRequest): Promise<unknown>;
  verify(input?: CapabilitySecurityRequest): Promise<unknown>;
  bindCapabilityKey(input?: CapabilitySecurityRequest): Promise<unknown>;
  verifyCapabilityKeyBinding(input?: CapabilitySecurityRequest): Promise<unknown>;
  verifyCapabilityAndBinding(input?: CapabilitySecurityRequest): Promise<unknown>;
  invalidate(input?: CapabilitySecurityRequest): Promise<unknown>;
  invalidateCapabilityCredential(input?: CapabilitySecurityRequest): Promise<unknown>;
  invalidateCredential(input?: CapabilitySecurityRequest): Promise<unknown>;
  invalidateCapabilityKeyBinding(input?: CapabilitySecurityRequest): Promise<unknown>;
  describe(input?: CapabilitySecurityRequest): Promise<unknown>;
  close(): Promise<void>;
}
type CommandJsonLabel = "Capability security helper" | "Opaque capability key helper";
export interface CommandJsonOptions { command: string; args?: string[]; env?: NodeJS.ProcessEnv; input?: CapabilitySecurityRequest; timeoutMs?: number; label?: CommandJsonLabel; }

const MAX_HELPER_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;
const HELPER_SHUTDOWN_GRACE_MS = 2_000;

function repoRoot(): string { return path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url))); }
export function capabilitySecurityHelperScriptPath(): string {
  return path.join(repoRoot(), "tools", "server-scripts", "meshrix-capability-security-helper.ts");
}

function helperError(label: CommandJsonLabel, reason: string): Error {
  const error: Error & { code?: string } = new Error(`${label} ${reason}.`);
  error.code = `capability_security_helper_${reason.replaceAll(" ", "_")}`;
  return error;
}

function runCommandJson({ command, args = [], env = {}, timeoutMs, label = "Capability security helper" }: CommandJsonOptions, signal: AbortSignal, serializedInput: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
      reject(new RangeError("timeoutMs must be a non-negative whole number."));
      return;
    }
    if (signal.aborted) {
      reject(helperError(label, "was cancelled by its owner"));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    } catch {
      reject(helperError(label, "could not be started"));
      return;
    }

    let stdoutBytes = 0;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let pendingError: Error | null = null;
    let settled = false;
    let terminationStarted = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let escalation: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", cancel);
    };
    const rejectAfterExit = (error: Error) => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      pendingError = error;
      try {
        child.kill("SIGTERM");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
      escalation = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, HELPER_SHUTDOWN_GRACE_MS);
      escalation.unref?.();
    };
    const cancel = () => rejectAfterExit(helperError(label, "was cancelled by its owner"));
    const collectOutput = (chunk: Buffer | string, isStdout: boolean) => {
      if (terminationStarted || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (outputBytes + buffer.byteLength > MAX_HELPER_OUTPUT_BYTES) {
        rejectAfterExit(helperError(label, "exceeded the output limit"));
        return;
      }
      outputBytes += buffer.byteLength;
      if (isStdout) {
        stdoutBytes += buffer.byteLength;
        stdout.push(buffer);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => collectOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => collectOutput(chunk, false));
    child.on("error", () => {
      rejectAfterExit(helperError(label, "could not be started"));
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        rejectAfterExit(helperError(label, "could not accept its request"));
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => rejectAfterExit(helperError(label, "exceeded its caller-selected budget")), timeoutMs);
      timeout.unref?.();
    }
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pendingError) {
        reject(pendingError);
        return;
      }
      if (code !== 0) {
        reject(helperError(label, "failed"));
        return;
      }
      try {
        const output = Buffer.concat(stdout, stdoutBytes).toString("utf8").trim();
        resolve(JSON.parse(output || "{}") as unknown);
      } catch {
        reject(helperError(label, "returned invalid JSON"));
      }
    });
    try {
      child.stdin.end(serializedInput);
    } catch {
      rejectAfterExit(helperError(label, "could not accept its request"));
    }
  });
}

export function createCommandJsonProcessOwner() {
  let queue = Promise.resolve();
  let activeController: AbortController | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  return Object.freeze({
    run(options: CommandJsonOptions): Promise<unknown> {
      const label: CommandJsonLabel = options.label === "Opaque capability key helper"
        ? "Opaque capability key helper"
        : "Capability security helper";
      if (closing) return Promise.reject(helperError(label, "is closed"));
      let serializedInput: string;
      try {
        serializedInput = `${JSON.stringify(options.input || {})}\n`;
      } catch {
        return Promise.reject(helperError(label, "request is not valid JSON"));
      }
      if (Buffer.byteLength(serializedInput) > MAX_HELPER_INPUT_BYTES) {
        return Promise.reject(helperError(label, "request exceeds the input limit"));
      }
      const controller = new AbortController();
      const operation = queue.catch(() => {}).then(async () => {
        if (closing) throw helperError(label, "is closed");
        activeController = controller;
        try {
          return await runCommandJson(options, controller.signal, serializedInput);
        } finally {
          activeController = null;
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      activeController?.abort();
      closePromise = queue;
      return closePromise;
    }
  });
}

export function createCommandCapabilitySecurityClient({ dataDir = "", backend = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER || "auto",
  alias = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants",
  bindingBackend = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER || "auto",
  bindingAlias = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS || "meshrix-tool-bindings", command = process.execPath,
  args = [capabilitySecurityHelperScriptPath()], env = {}, timeoutMs }: CommandCapabilitySecurityClientOptions = {}): CommandCapabilitySecurityClient {
  const owner = createCommandJsonProcessOwner();
  const request = (action: string, input: CapabilitySecurityRequest = {}): Promise<unknown> => owner.run({ command, args, env, timeoutMs,
    label: "Capability security helper", input: { protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION, action, dataDir, backend, alias, bindingBackend, bindingAlias, ...input } });
  return Object.freeze({ protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION, provider: "command-helper" as const, alias,
    issue: (input = {}) => request("issueCapabilityKey", input), verify: (input = {}) => request("verifyCapability", input),
    bindCapabilityKey: (input = {}) => request("bindCapabilityKey", input), verifyCapabilityKeyBinding: (input = {}) => request("verifyBinding", input),
    verifyCapabilityAndBinding: (input = {}) => request("verifyCapabilityAndBinding", input), invalidate: (input = {}) => request("invalidateCapabilityKey", input),
    invalidateCapabilityCredential: (input = {}) => request("invalidateCapabilityCredential", input),
    invalidateCredential: (input = {}) => request("invalidateCredential", input),
    invalidateCapabilityKeyBinding: (input = {}) => request("invalidateCapabilityBinding", input), describe: (input = {}) => request("describe", input), close: () => owner.close() });
}
