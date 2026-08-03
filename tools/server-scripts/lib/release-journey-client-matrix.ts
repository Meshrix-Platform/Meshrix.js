import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { MCP_TARGET_LABELS } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";

export async function createMatrixTargetEnvironment({
  workDir,
  target,
  adapterCacheRoot
}: Record<string, any> = {}) : Promise<any> {
  const home: any = path.join(workDir, "client-homes", target);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  return {
    HOME: home,
    KIMI_CODE_HOME: path.join(home, ".kimi-code"),
    MESHRIX_MCP_PROCESS_IDENTITY_STORE: "file",
    MESHRIX_MCP_ADAPTER_CACHE: adapterCacheRoot,
    MESHRIX_MCP_DISCOVERY_FILE: path.join(workDir, "client-discovery", `${target}.json`)
  };
}

export async function installMatrixTargetWithApiKey({
  connectorScript,
  target,
  clientCommand,
  baseUrl,
  adapterCacheRoot,
  env,
  redact = (value?: any) : any => value
}: Record<string, any> = {}) : Promise<any> {
  const args: any[] = [
    connectorScript,
    "install",
    "--target", target,
    "--url", baseUrl,
    "--json",
    "--adapter-cache", adapterCacheRoot,
    "--client-command", clientCommand,
    "--discovery-file", env.MESHRIX_MCP_DISCOVERY_FILE,
    "--token-env", "MESHRIX_MCP_TOKEN",
    "--no-auto-token",
    "--no-verify"
  ];
  const child: any = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout: any = "";
  let stderr: any = "";
  child.stdout.on("data", (chunk?: any) : any => {
    if (stdout.length < 512 * 1024) stdout += chunk;
  });
  child.stderr.on("data", (chunk?: any) : any => {
    if (stderr.length < 128 * 1024) stderr += chunk;
  });
  const exitCode: any = await new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("close", (code?: any) : any => resolve(code ?? 1));
  });
  let payload: any = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  const installed: any = payload?.installed?.[target];
  if (
    exitCode !== 0
    || payload?.ok !== true
    || installed?.status !== "installed"
    || installed?.tokenSource !== "provided"
    || /authorization\s+mcp_auth_req_/iu.test(stderr)
  ) {
    const error: Error & Record<string, any> = new Error(
      `Connector API Key install failed for ${target}: ${redact(String(installed?.error || stderr)).slice(-600)}`
    );
    error.code = "release_journey_install_failed";
    throw error;
  }
  return {
    target,
    label: MCP_TARGET_LABELS[target] || target,
    status: "installed",
    credentialSource: "pre-issued-api-key",
    adapterCacheHit: installed.adapterCacheHit === true,
    postInstallVerification: "deferred_to_mcp_acceptance_matrix"
  };
}

export async function uninstallMatrixTarget({
  connectorScript,
  target,
  env,
  redact = (value?: any) : any => value
}: Record<string, any> = {}) : Promise<any> {
  const child: any = spawn(process.execPath, [
    connectorScript,
    "uninstall",
    "--target", target,
    "--json"
  ], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout: any = "";
  child.stdout.on("data", (chunk?: any) : any => {
    if (stdout.length < 128 * 1024) stdout += chunk;
  });
  const exitCode: any = await new Promise((resolve?: any) : any => child.once("close", (code?: any) : any => resolve(code ?? 1)));
  let payload: any = null;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    payload = null;
  }
  const result: any = payload?.uninstalled?.[target];
  const removed: any = result?.status === "not-installed"
    && result?.localProcessIdentityRemoved === true
    && (result?.serverDeviceRemoved === true || result?.serverDeviceRemoval === "not-applicable");
  return {
    target,
    exitCode,
    ok: exitCode === 0 && removed,
    detail: redact(stdout).slice(-300)
  };
}
