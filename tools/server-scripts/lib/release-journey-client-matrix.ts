import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { MCP_TARGET_LABELS } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";
import { listPendingAuthorizationRequests } from "./release-journey-console.ts";

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

export function startConnectorInstall({
  connectorScript,
  target,
  clientCommand,
  baseUrl,
  adapterCacheRoot,
  toolsets,
  scopes,
  maxRisk,
  upstreamCapabilities,
  allowedService,
  env,
  consoleClient,
  redact = (value?: any) : any => value
}: Record<string, any> = {}) : any {
  const args: any[] = [
    connectorScript,
    "install",
    "--target", target,
    "--url", baseUrl,
    "--json",
    "--adapter-cache", adapterCacheRoot,
    "--toolsets", toolsets,
    "--scopes", scopes,
    "--max-risk", maxRisk,
    "--upstream-capability", upstreamCapabilities.join(","),
    "--allowed-service", allowedService,
    "--client-command", clientCommand,
    "--discovery-file", env.MESHRIX_MCP_DISCOVERY_FILE,
    "--no-verify"
  ];
  const child: any = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout: any = "";
  let stderr: any = "";
  let pendingObserved: any = false;
  child.stdout.on("data", (chunk?: any) : any => {
    if (stdout.length < 512 * 1024) stdout += chunk;
  });
  child.stderr.on("data", (chunk?: any) : any => {
    if (stderr.length < 128 * 1024) stderr += chunk;
  });
  const exitPromise: any = new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("close", (code?: any) : any => resolve(code ?? 1));
  });

  const pending: any = new Promise((resolve?: any, reject?: any) : any => {
    const timer: any = setTimeout(() : any => {
      reject(Object.assign(
        new Error(`Connector install did not submit a device authorization request in time: ${redact(stderr).slice(-600)}`),
        { code: "release_journey_authorization_missing" }
      ));
    }, 60_000);
    child.stderr.on("data", async () : Promise<any> => {
      const match: any = /authorization\s+(mcp_auth_req_[A-Za-z0-9_]+)\s+is pending/u.exec(stderr);
      if (!match || pendingObserved) return;
      pendingObserved = true;
      clearTimeout(timer);
      const requestId: any = match[1];
      try {
        const requests: any = await listPendingAuthorizationRequests(consoleClient);
        const request: any = requests.find((entry?: any) : any => entry.requestId === requestId);
        if (!request || !Array.isArray(request.targets) || !request.targets.includes(target)) {
          throw Object.assign(
            new Error("Device authorization request is not visible with the expected target."),
            { code: "release_journey_authorization_missing" }
          );
        }
        resolve({
          target,
          label: MCP_TARGET_LABELS[target] || target,
          requestId,
          verificationCodeMatched: Boolean(
            /code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/u.exec(stderr)?.[1]
          )
        });
      } catch (error: any) {
        reject(error);
      }
    });
    child.once("error", (error?: any) : any => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code?: any) : any => {
      clearTimeout(timer);
      reject(Object.assign(
        new Error(`Connector install exited (${code}) before device authorization completed.`),
        { code: "release_journey_install_failed" }
      ));
    });
  });

  async function complete() : Promise<any> {
    const exitCode: any = await exitPromise;
    let payload: any = null;
    try {
      payload = JSON.parse(stdout.trim());
    } catch {
      payload = null;
    }
    const installed: any = payload?.installed?.[target];
    if (exitCode !== 0 || payload?.ok !== true || installed?.status !== "installed") {
      const error: Error & Record<string, any> = new Error(
        `Connector install failed for ${target}: ${redact(String(installed?.error || stderr)).slice(-600)}`
      );
      error.code = "release_journey_install_failed";
      throw error;
    }
    return {
      target,
      label: MCP_TARGET_LABELS[target] || target,
      status: "installed",
      adapterCacheHit: installed.adapterCacheHit === true,
      postInstallVerification: "deferred_to_mcp_acceptance_matrix"
    };
  }

  return { target, pending, complete };
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
  const removed: any = result?.serverDeviceRemoved === true && result?.localProcessIdentityRemoved === true;
  return {
    target,
    exitCode,
    ok: exitCode === 0 && removed,
    detail: redact(stdout).slice(-300)
  };
}
