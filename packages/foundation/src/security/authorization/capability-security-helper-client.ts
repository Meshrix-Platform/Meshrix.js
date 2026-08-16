import { spawn } from "node:child_process";
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
  close(): void;
}
interface CommandJsonOptions { command: string; args?: string[]; env?: NodeJS.ProcessEnv; input?: CapabilitySecurityRequest; timeoutMs?: number; }

function repoRoot(): string { return path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url))); }
export function capabilitySecurityHelperScriptPath(): string {
  return path.join(repoRoot(), "tools", "server-scripts", "meshrix-capability-security-helper.ts");
}
function runCommandJson({ command, args = [], env = {}, input = {}, timeoutMs = 15000 }: CommandJsonOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Capability security helper timed out: ${command}`)); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", (error: Error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(stderr.trim() || `Capability security helper failed with exit code ${code}.`)); return; }
      try { resolve(JSON.parse(stdout.trim() || "{}") as unknown); }
      catch (error: unknown) { reject(new Error(`Capability security helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)); }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export function createCommandCapabilitySecurityClient({ dataDir = "", backend = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER || "auto",
  alias = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants",
  bindingBackend = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER || "auto",
  bindingAlias = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS || "meshrix-tool-bindings", command = process.execPath,
  args = [capabilitySecurityHelperScriptPath()], env = {}, timeoutMs = 15000 }: CommandCapabilitySecurityClientOptions = {}): CommandCapabilitySecurityClient {
  const request = (action: string, input: CapabilitySecurityRequest = {}): Promise<unknown> => runCommandJson({ command, args, env, timeoutMs,
    input: { protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION, action, dataDir, backend, alias, bindingBackend, bindingAlias, ...input } });
  return Object.freeze({ protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION, provider: "command-helper" as const, alias,
    issue: (input = {}) => request("issueCapabilityKey", input), verify: (input = {}) => request("verifyCapability", input),
    bindCapabilityKey: (input = {}) => request("bindCapabilityKey", input), verifyCapabilityKeyBinding: (input = {}) => request("verifyBinding", input),
    verifyCapabilityAndBinding: (input = {}) => request("verifyCapabilityAndBinding", input), invalidate: (input = {}) => request("invalidateCapabilityKey", input),
    invalidateCapabilityCredential: (input = {}) => request("invalidateCapabilityCredential", input),
    invalidateCredential: (input = {}) => request("invalidateCredential", input),
    invalidateCapabilityKeyBinding: (input = {}) => request("invalidateCapabilityBinding", input), describe: (input = {}) => request("describe", input), close() {} });
}
