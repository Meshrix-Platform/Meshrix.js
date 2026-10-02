import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_CLIENT_ADAPTER_PROTOCOL,
  mcpClientAdapterForTarget
} from "../../mcp-release-targets.ts";
import { INSTALL_COMMAND_TIMEOUT_MS } from "./constants.ts";
import {
  connectorLaunchSpec,
  runWithInput
} from "./connector-process.ts";
import { redactSensitiveText } from "./installer-output-safety.ts";

export const CLIENT_ADAPTER_DESCRIPTOR_SCHEMA: any = "v0.0.1:meshrix:client-adapter-descriptor-1";
export const CLIENT_ADAPTER_MAX_MESSAGE_BYTES: any = 256 * 1024;

const CLIENT_ADAPTER_ACTIONS: any = new Set<any>(["describe", "scan", "install", "verify", "uninstall"]);

function adapterError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

async function findPackageRoot(entrypoint?: any, packageName?: any) : Promise<any> {
  let current: any = path.dirname(entrypoint);
  while (true) {
    let manifest: any;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw adapterError("CLIENT_ADAPTER_PACKAGE_INVALID", "Installed client adapter package metadata is invalid.");
      }
    }
    if (manifest?.name === packageName) return current;
    const parent: any = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw adapterError("CLIENT_ADAPTER_PACKAGE_MISMATCH", "Installed client adapter package identity does not match the trusted component.");
}

function containedPath(root?: any, candidate?: any) : boolean {
  const relative: any = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve one first-party adapter from the current installation using Node's package resolver. */
export async function resolveInstalledClientAdapter({
  target,
  resolveModule = import.meta.resolve
}: Record<string, any> = {}) : Promise<any> {
  const trusted: any = mcpClientAdapterForTarget(target);
  if (!trusted) {
    throw adapterError("CLIENT_ADAPTER_TARGET_UNSUPPORTED", "Client adapter target is not trusted by this connector release.");
  }

  let resolvedUrl: any;
  try {
    resolvedUrl = resolveModule(`${trusted.packageName}/${trusted.entrypoint}`);
  } catch {
    throw adapterError("CLIENT_ADAPTER_PACKAGE_MISSING", "The requested first-party client adapter is not present in this installation.");
  }
  if (typeof resolvedUrl !== "string" || !resolvedUrl.startsWith("file:")) {
    throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_INVALID", "Installed client adapter entrypoint did not resolve to a local file.");
  }

  let entrypoint: any;
  let packageRoot: any;
  try {
    entrypoint = await fs.realpath(fileURLToPath(resolvedUrl));
    const resolvedPackageRoot: any = await findPackageRoot(entrypoint, trusted.packageName);
    packageRoot = await fs.realpath(resolvedPackageRoot);
  } catch (error: any) {
    if (error?.code?.startsWith("CLIENT_ADAPTER_")) throw error;
    throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_MISSING", "Installed client adapter entrypoint is unavailable.");
  }

  if (!containedPath(packageRoot, entrypoint)) {
    throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_INVALID", "Client adapter entrypoint escapes its installed package root.");
  }
  const manifest: any = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest?.name !== trusted.packageName || manifest?.version !== trusted.version) {
    throw adapterError("CLIENT_ADAPTER_PACKAGE_MISMATCH", "Installed client adapter package version does not match the root release.");
  }
  const stat: any = await fs.stat(entrypoint).catch(() : any => null);
  if (!stat?.isFile()) {
    throw adapterError("CLIENT_ADAPTER_ENTRYPOINT_MISSING", "Installed client adapter entrypoint is unavailable.");
  }

  return {
    packageRoot,
    entrypoint,
    adapter: { ...trusted, target }
  };
}

function assertSecretFreeRequest(value?: any, pathParts: any = []) : any {
  if (Array.isArray(value)) {
    value.forEach((child?: any, index?: any) : any => assertSecretFreeRequest(child, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    const normalized: any = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    const allowedReference: any = normalized === "tokenenv" || normalized.endsWith("ref");
    if (!allowedReference && /(token|secret|password|privatekey|authorization|apikey)/u.test(normalized)) {
      throw adapterError("CLIENT_ADAPTER_SECRET_REJECTED", `Client adapter request field ${[...pathParts, key].join(".")} is not allowed.`);
    }
    assertSecretFreeRequest(child, [...pathParts, key]);
  }
}

function parseAdapterResponse(output?: any) : any {
  if (Buffer.byteLength(output) > CLIENT_ADAPTER_MAX_MESSAGE_BYTES) {
    throw adapterError("CLIENT_ADAPTER_RESPONSE_TOO_LARGE", "Client adapter response exceeded the protocol limit.");
  }
  let response: any;
  try {
    response = JSON.parse(String(output || "").trim());
  } catch {
    throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter returned invalid JSON.");
  }
  if (response?.schemaVersion !== MCP_CLIENT_ADAPTER_PROTOCOL || typeof response?.ok !== "boolean") {
    throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter response does not match the protocol schema.");
  }
  if (response.ok !== true) {
    throw adapterError(
      String(response?.error?.code || "CLIENT_ADAPTER_FAILED"),
      redactSensitiveText(response?.error?.message || "Client adapter operation failed.")
    );
  }
  if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
    throw adapterError("CLIENT_ADAPTER_RESPONSE_INVALID", "Client adapter response result is missing.");
  }
  return response.result;
}

export async function runClientAdapter({
  target,
  action,
  request = {},
  resolveModule
}: Record<string, any> = {}) : Promise<any> {
  if (!CLIENT_ADAPTER_ACTIONS.has(action)) {
    throw adapterError("CLIENT_ADAPTER_ACTION_INVALID", "Client adapter action is invalid.");
  }
  const payload: Record<string, any> = { schemaVersion: MCP_CLIENT_ADAPTER_PROTOCOL, ...request };
  assertSecretFreeRequest(payload);
  const input: any = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(input) > CLIENT_ADAPTER_MAX_MESSAGE_BYTES) {
    throw adapterError("CLIENT_ADAPTER_REQUEST_TOO_LARGE", "Client adapter request exceeded the protocol limit.");
  }
  const installed: any = await resolveInstalledClientAdapter({ target, resolveModule });
  const executed: any = await runWithInput(process.execPath, [installed.entrypoint, action], input, {
    allowFailure: true,
    cleanEnv: true,
    timeoutMs: INSTALL_COMMAND_TIMEOUT_MS
  });
  if (!executed.ok) {
    throw adapterError("CLIENT_ADAPTER_PROCESS_FAILED", redactSensitiveText(executed.stderr || "Client adapter process failed."));
  }
  return {
    result: parseAdapterResponse(executed.stdout),
    adapter: installed.adapter
  };
}

export function clientAdapterConnectorRequest({ baseUrl, tokenEnv, client = {} }: Record<string, any> = {}) : any {
  const connector: any = connectorLaunchSpec();
  return {
    baseUrl,
    tokenEnv,
    connector: {
      command: connector.command,
      args: [...connector.args]
    },
    client
  };
}

export async function describeClientAdapter(options: Record<string, any> = {}) : Promise<any> {
  const executed: any = await runClientAdapter({ ...options, action: "describe", request: {} });
  const descriptor: any = executed.result;
  if (
    descriptor.schemaVersion !== CLIENT_ADAPTER_DESCRIPTOR_SCHEMA ||
    descriptor.protocol !== MCP_CLIENT_ADAPTER_PROTOCOL ||
    descriptor.target !== options.target ||
    descriptor.packageName !== executed.adapter.packageName ||
    descriptor.version !== executed.adapter.version ||
    !Array.isArray(descriptor.commandNames) ||
    !Array.isArray(descriptor.actions) ||
    ![...CLIENT_ADAPTER_ACTIONS].every((action?: any) : any => descriptor.actions.includes(action)) ||
    JSON.stringify(descriptor.locations) !== JSON.stringify(["local"])
  ) {
    throw adapterError("CLIENT_ADAPTER_DESCRIPTOR_MISMATCH", "Client adapter descriptor does not match its trusted target identity.");
  }
  return executed;
}
