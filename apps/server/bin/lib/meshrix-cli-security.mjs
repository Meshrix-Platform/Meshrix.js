import fsp from "node:fs/promises";
import path from "node:path";
import {
  capabilityKernelStatePath,
  createOpaqueCapabilityKeyProvider
} from "../../../../packages/foundation/src/security/authorization/opaque-capability-key.mjs";
import {
  capabilityBindingGuardStatePath,
  createCapabilityBindingGuard
} from "../../../../packages/foundation/src/security/authorization/capability-binding-guard.mjs";
import { readJsonInput, readStdinText, trimOneTrailingNewline, writeResponse } from "./meshrix-cli-common.mjs";

const DEFAULT_CAPABILITY_KERNEL_ALIAS = "meshrix-tool-grants";
const DEFAULT_CAPABILITY_BINDING_GUARD_ALIAS = "meshrix-tool-bindings";
const SECURITY_RECOVERY_PACKAGE_VERSION = "v0.0.1:risk-control:recovery-1";

function securityCommandFromArgs(args) {
  const first = String(args._[0] || "");
  if (first.startsWith("security.")) {
    const [, domain = "capability-kernel", action = "status"] = first.split(".");
    return {
      matched: true,
      domain: domain || "capability-kernel",
      action: action || "status"
    };
  }
  if (first !== "security" && first !== "secure") {
    return { matched: false, domain: "", action: "" };
  }
  const domain = String(args._[1] || "capability-kernel");
  const action = String(args._[2] || "status");
  return { matched: true, domain, action };
}

function capabilityKernelOptions(args = {}) {
  return {
    dataDir: args["data-dir"] || "",
    backend: args.backend || process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER || process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER || "auto",
    alias: args.alias || process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS || DEFAULT_CAPABILITY_KERNEL_ALIAS
  };
}

function capabilityBindingGuardOptions(args = {}) {
  return {
    dataDir: args["data-dir"] || "",
    backend: args["binding-backend"] ||
      args.backend ||
      process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
      process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
      "auto",
    alias: args["binding-alias"] ||
      process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS ||
      process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS ||
      DEFAULT_CAPABILITY_BINDING_GUARD_ALIAS
  };
}

async function readRecoveryPassphrase(args = {}) {
  const sources = [
    ["passphrase-stdin", args["passphrase-stdin"]],
    ["passphrase-file", args["passphrase-file"]],
    ["passphrase-env", args["passphrase-env"]]
  ].filter(([, value]) => value);
  if (sources.length !== 1) {
    throw new Error("Recovery commands require exactly one passphrase source: --passphrase-stdin, --passphrase-file, or --passphrase-env.");
  }
  const [source, value] = sources[0];
  if (source === "passphrase-stdin") {
    return trimOneTrailingNewline(await readStdinText());
  }
  if (source === "passphrase-file") {
    return trimOneTrailingNewline(await fsp.readFile(path.resolve(String(value)), "utf8"));
  }
  const passphrase = process.env[String(value)];
  if (!passphrase) {
    throw new Error(`Recovery passphrase environment variable is not set: ${value}`);
  }
  return passphrase;
}

async function writePrivateJsonFile(filePath, value) {
  const outputPath = path.resolve(String(filePath || ""));
  if (!outputPath) {
    throw new Error("--output is required.");
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(outputPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.chmod(outputPath, 0o600);
  return outputPath;
}

function summarizeRecoveryComponent(component = null) {
  if (!component || typeof component !== "object") {
    return null;
  }
  return {
    protocolVersion: String(component.protocolVersion || ""),
    alias: String(component.alias || ""),
    epoch: Number(component.epoch || 0),
    stateRoot: String(component.stateRoot || "")
  };
}

function composeSecurityRecoveryPackage({
  capabilityKernel = null,
  capabilityBindingGuard = null
} = {}) {
  const exportedAt = new Date().toISOString();
  return {
    protocolVersion: SECURITY_RECOVERY_PACKAGE_VERSION,
    exportedAt,
    components: {
      capabilityKernel,
      capabilityBindingGuard
    }
  };
}

async function exportSecurityRecoveryPackage({ provider, bindingGuard, passphrase, reason = "" } = {}) {
  const [capabilityKernel, capabilityBindingGuard] = await Promise.all([
    provider.exportRecoveryPackage({ passphrase, reason }),
    bindingGuard.exportRecoveryPackage({ passphrase, reason })
  ]);
  return composeSecurityRecoveryPackage({ capabilityKernel, capabilityBindingGuard });
}

function isSecurityRecoveryPackage(recoveryPackage = {}) {
  return recoveryPackage?.protocolVersion === SECURITY_RECOVERY_PACKAGE_VERSION;
}

async function importSecurityRecoveryPackage({
  provider,
  bindingGuard,
  recoveryPackage,
  passphrase
} = {}) {
  if (isSecurityRecoveryPackage(recoveryPackage)) {
    const components = recoveryPackage.components && typeof recoveryPackage.components === "object"
      ? recoveryPackage.components
      : {};
    const result = {
      ok: true,
      protocolVersion: SECURITY_RECOVERY_PACKAGE_VERSION,
      imported: true,
      components: {}
    };
    if (components.capabilityKernel) {
      result.components.capabilityKernel = await provider.importRecoveryPackage({
        recoveryPackage: components.capabilityKernel,
        passphrase
      });
    }
    if (components.capabilityBindingGuard) {
      result.components.capabilityBindingGuard = await bindingGuard.importRecoveryPackage({
        recoveryPackage: components.capabilityBindingGuard,
        passphrase
      });
    }
    return result;
  }
  if (recoveryPackage?.protocolVersion === "v0.0.1:risk-control:capability-binding-guard-recovery-1") {
    return {
      ok: true,
      protocolVersion: SECURITY_RECOVERY_PACKAGE_VERSION,
      imported: true,
      components: {
        capabilityBindingGuard: await bindingGuard.importRecoveryPackage({
          recoveryPackage,
          passphrase
        })
      }
    };
  }
  return {
    ok: true,
    protocolVersion: SECURITY_RECOVERY_PACKAGE_VERSION,
    imported: true,
    components: {
      capabilityKernel: await provider.importRecoveryPackage({
        recoveryPackage,
        passphrase
      })
    }
  };
}

export async function runSecurityCommand(args) {
  const command = securityCommandFromArgs(args);
  if (!command.matched) {
    return false;
  }
  const domain = command.domain;
  const action = command.action;
  const options = capabilityKernelOptions(args);
  const bindingOptions = capabilityBindingGuardOptions(args);
  const provider = createOpaqueCapabilityKeyProvider(options);
  const bindingGuard = createCapabilityBindingGuard(bindingOptions);
  try {
    if (domain === "capability-kernel" || domain === "capability" || domain === "kernel") {
      if (action !== "status" && action !== "describe") {
        throw new Error(`未知 security capability-kernel 命令：${args._.join(" ")}`);
      }
      const description = await provider.describe();
      await writeResponse({
        args,
        result: {
          ok: true,
          capabilityKernel: {
            ...description,
            statePath: options.backend === "local-file" ? capabilityKernelStatePath(options) : "",
            degraded: description.securityMode === "degraded_file_fallback"
          }
        }
      });
      return true;
    }
    if (domain === "binding-guard" || domain === "binding" || domain === "capability-binding-guard") {
      if (action !== "status" && action !== "describe") {
        throw new Error(`未知 security binding-guard 命令：${args._.join(" ")}`);
      }
      const description = await bindingGuard.describe();
      await writeResponse({
        args,
        result: {
          ok: true,
          capabilityBindingGuard: {
            ...description,
            statePath: bindingOptions.backend === "local-file" ? capabilityBindingGuardStatePath(bindingOptions) : description.statePath || "",
            degraded: description.securityMode === "degraded_file_fallback"
          }
        }
      });
      return true;
    }
    if (domain !== "recovery") {
      throw new Error(`未知 security 命令：${args._.join(" ")}`);
    }
    if (action === "export") {
      const passphrase = await readRecoveryPassphrase(args);
      const recoveryPackage = await exportSecurityRecoveryPackage({
        provider,
        bindingGuard,
        passphrase,
        reason: args.reason || ""
      });
      if (args.output) {
        const outputPath = await writePrivateJsonFile(args.output, recoveryPackage);
        await writeResponse({
          args: { ...args, output: "" },
          result: {
            ok: true,
            protocolVersion: recoveryPackage.protocolVersion,
            exportedAt: recoveryPackage.exportedAt,
            components: {
              capabilityKernel: summarizeRecoveryComponent(recoveryPackage.components.capabilityKernel),
              capabilityBindingGuard: summarizeRecoveryComponent(recoveryPackage.components.capabilityBindingGuard)
            },
            outputPath
          }
        });
      } else {
        await writeResponse({ args, result: recoveryPackage });
      }
      return true;
    }
    if (action === "import") {
      const inputPath = args.input || args.file?.[0] || args._[3];
      if (!inputPath || inputPath === true) {
        throw new Error("security recovery import requires --input recovery.json.");
      }
      const passphrase = await readRecoveryPassphrase(args);
      const recoveryPackage = await readJsonInput(String(inputPath), "--input");
      const imported = await importSecurityRecoveryPackage({
        provider,
        bindingGuard,
        recoveryPackage,
        passphrase
      });
      await writeResponse({
        args,
        result: imported
      });
      return true;
    }
    throw new Error(`未知 security recovery 命令：${args._.join(" ")}`);
  } finally {
    provider.close?.();
    bindingGuard.close?.();
  }
}
