import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION: any = "v0.0.1:risk-control:capability-security-helper-1";

function repoRoot() : any {
  return path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
}

export function capabilitySecurityHelperScriptPath() : any {
  return path.join(repoRoot(), "tools", "server-scripts", "meshrix-capability-security-helper.ts");
}

function runCommandJson({ command, args = [], env = {}, input = {}, timeoutMs = 15000 }: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    let stdout: any = "";
    let stderr: any = "";
    const timeout: any = setTimeout(() : any => {
      child.kill("SIGTERM");
      reject(new Error(`Capability security helper timed out: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString();
    });
    child.on("error", (error?: any) : any => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code?: any) : any => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Capability security helper failed with exit code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error: any) {
        reject(new Error(`Capability security helper returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export function createCommandCapabilitySecurityClient({
  dataDir = "",
  backend = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER || "auto",
  alias = process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS || "meshrix-tool-grants",
  bindingBackend = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER || "auto",
  bindingAlias = process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS || "meshrix-tool-bindings",
  command = process.execPath,
  args = [capabilitySecurityHelperScriptPath()],
  env = {},
  timeoutMs = 15000
}: Record<string, any> = {}) : any {
  async function request(action?: any, input: Record<string, any> = {}) : Promise<any> {
    return runCommandJson({
      command,
      args,
      env,
      timeoutMs,
      input: {
        protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
        action,
        dataDir,
        backend,
        alias,
        bindingBackend,
        bindingAlias,
        ...input
      }
    });
  }

  return Object.freeze({
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    provider: "command-helper",
    alias,
    issue: (input: Record<string, any> = {}) : any => request("issueCapabilityKey", input),
    verify: (input: Record<string, any> = {}) : any => request("verifyCapability", input),
    bindCapabilityKey: (input: Record<string, any> = {}) : any => request("bindCapabilityKey", input),
    verifyCapabilityKeyBinding: (input: Record<string, any> = {}) : any => request("verifyBinding", input),
    verifyCapabilityAndBinding: (input: Record<string, any> = {}) : any => request("verifyCapabilityAndBinding", input),
    invalidate: (input: Record<string, any> = {}) : any => request("invalidateCapabilityKey", input),
    invalidateCapabilityCredential: (input: Record<string, any> = {}) : any => request("invalidateCapabilityCredential", input),
    invalidateCredential: (input: Record<string, any> = {}) : any => request("invalidateCredential", input),
    invalidateCapabilityKeyBinding: (input: Record<string, any> = {}) : any => request("invalidateCapabilityBinding", input),
    describe: (input: Record<string, any> = {}) : any => request("describe", input),
    close() : any {}
  });
}
