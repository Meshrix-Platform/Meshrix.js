import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION = "v0.0.1:risk-control:capability-security-helper-1";

function repoRoot() {
  return path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
}

export function capabilitySecurityHelperScriptPath() {
  return path.join(repoRoot(), "tools", "server-scripts", "meshrix-capability-security-helper.mjs");
}

function runCommandJson({ command, args = [], env = {}, input = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Capability security helper timed out: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Capability security helper failed with exit code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
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
} = {}) {
  async function request(action, input = {}) {
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
    issue: (input = {}) => request("issueCapabilityKey", input),
    verify: (input = {}) => request("verifyCapability", input),
    bindCapabilityKey: (input = {}) => request("bindCapabilityKey", input),
    verifyCapabilityKeyBinding: (input = {}) => request("verifyBinding", input),
    verifyCapabilityAndBinding: (input = {}) => request("verifyCapabilityAndBinding", input),
    invalidate: (input = {}) => request("invalidateCapabilityKey", input),
    invalidateCapabilityCredential: (input = {}) => request("invalidateCapabilityCredential", input),
    invalidateCredential: (input = {}) => request("invalidateCredential", input),
    invalidateCapabilityKeyBinding: (input = {}) => request("invalidateCapabilityBinding", input),
    describe: (input = {}) => request("describe", input),
    close() {}
  });
}
