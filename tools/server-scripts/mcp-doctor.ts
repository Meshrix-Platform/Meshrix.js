import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  MCP_STABLE_TOOL_NAME
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";

let fatalReported: any = false;
function reportFatal(error?: any) : any {
  if (fatalReported) return;
  fatalReported = true;
  console.error(JSON.stringify({
    ok: false,
    errorCode: String(error?.code || "MCP_DOCTOR_FAILED")
  }));
  process.exitCode = 1;
}
process.on("uncaughtException", reportFatal);
process.on("unhandledRejection", reportFatal);

const execFileAsync: any = promisify(execFile);

function argValue(name?: any, fallback: any = "") : any {
  const index: any = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasArg(name?: any) : any {
  return process.argv.includes(name);
}

async function readDoctorToken() : Promise<any> {
  if (process.argv.some((argument?: any) : any => argument === "--token" || argument.startsWith("--token="))) {
    throw Object.assign(
      new Error("Raw tokens are not accepted in process arguments. Use --token-stdin or --token-env."),
      { code: "RAW_TOKEN_ARGUMENT_REJECTED" }
    );
  }
  const tokenEnv: any = String(argValue("--token-env", "MESHRIX_MCP_TOKEN")).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) {
    throw Object.assign(new Error("Invalid --token-env name."), { code: "TOKEN_ENV_NAME_INVALID" });
  }
  const environmentToken: any = String(process.env[tokenEnv] || "").trim();
  const stdinToken: any = hasArg("--token-stdin")
    ? String(readFileSync(0, "utf8")).trim()
    : "";
  if (environmentToken && stdinToken) {
    throw Object.assign(new Error("Token input is ambiguous. Use exactly one token source."), {
      code: "TOKEN_INPUT_AMBIGUOUS"
    });
  }
  return stdinToken || environmentToken;
}

function parseOrbStackTargets() : any {
  const raw: any = String(process.env.MESHRIX_MCP_ORBSTACK_TARGETS || "").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item?: any) : any => item.trim())
    .filter(Boolean)
    .map((item?: any) : any => {
      const [vm, user] = item.split(":").map((part?: any) : any => String(part || "").trim());
      return { vm, user };
    })
    .filter((item?: any) : any => item.vm && item.user);
}

async function run(command?: any, args: any = [], options: Record<string, any> = {}) : Promise<any> {
  try {
    const timeoutMs: any = Number(options.timeoutMs || 30000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
      throw new Error("mcp_doctor_child_timeout_invalid");
    }
    const result: any = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGTERM"
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error: any) {
    if (options.allowFailure) {
      return {
        ok: false,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || ""
      };
    }
    throw error;
  }
}

async function jsonFetch(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function mcpRequest(method?: any, params: Record<string, any> = {}, id: any = 1) : any {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
}

async function readDeviceManifest() : Promise<any> {
  const manifestPath: any = process.env.MESHRIX_MCP_DISCOVERY_FILE || path.join(os.homedir(), ".meshrix", "mcp", "servers.json");
  try {
    const payload: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const server: any = payload?.servers?.meshrix || {};
    const targets: any = server.targets || {};
    const installedTargets: any = (Object.entries(targets) as [string, any][])
      .filter(([, value]: any[]) : any => value?.status === "installed")
      .map(([target]: any[]) : any => target);
    return {
      ok: server.httpUrl === `${baseUrl}/mcp`,
      pathRedacted: true,
      exists: true,
      httpUrl: server.httpUrl || "",
      vmHttpUrl: server.vmHttpUrl || "",
      connector: server.connector || null,
      installedTargets,
      targets
    };
  } catch (error: any) {
    return {
      ok: false,
      pathRedacted: true,
      exists: false,
      error: error?.code === "ENOENT" ? "manifest_not_found" : "manifest_unreadable",
      installedTargets: [],
      targets: {}
    };
  }
}

function orbFailureReason(result: Record<string, any> = {}) : any {
  const text: any = String(result.stderr || result.stdout || "").trim();
  if (/start VM|VM exited unexpectedly|timed out waiting for VM to start/iu.test(text)) {
    return "orb-vm-start-failed";
  }
  if (/curl|connect|timed out|refused|Could not resolve/iu.test(text)) {
    return "vm-health-http-failed";
  }
  return result.ok ? "" : "orb-check-failed";
}

async function checkOrbStackVm({ targetIndex, vm, user, healthUrl }: Record<string, any>) : Promise<any> {
  const result: any = await run("orb", [
    "-m",
    vm,
    "-u",
    user,
    "curl",
    "-fsS",
    "--max-time",
    "5",
    healthUrl
  ], { allowFailure: true });
  return {
    ok: result.ok && result.stdout.includes("\"ok\":true"),
    targetIndex,
    skipped: false,
    reason: orbFailureReason(result)
  };
}

async function checkConfiguredOrbStackTargets(vmHealthUrl?: any) : Promise<any> {
  if (!vmHealthUrl) {
    return {
      configured: false,
      targets: [],
      reason: "No VM health URL discovered."
    };
  }
  const targets: any = parseOrbStackTargets();
  if (targets.length === 0) {
    return {
      configured: false,
      targets: [],
      reason: "Set MESHRIX_MCP_ORBSTACK_TARGETS=vm:user[,vm:user] to verify OrbStack VM reachability."
    };
  }
  return {
    configured: true,
    targets: await Promise.all(targets.map((target?: any, index?: any) : any =>
      checkOrbStackVm({
        targetIndex: index,
        vm: target.vm,
        user: target.user,
        healthUrl: vmHealthUrl
      })
    )),
    reason: ""
  };
}

async function discoverSignedBaseUrl() : Promise<any> {
  const explicitUrl: any = String(argValue("--url", process.env.MESHRIX_MCP_BASE_URL || "")).trim();
  const args: any[] = ["packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh", "discover-local", "--json"];
  if (explicitUrl) {
    args.push("--url", explicitUrl);
  }
  const result: any = await run("sh", args);
  const payload: any = JSON.parse(result.stdout);
  if (!payload.ok || !payload.baseUrl) {
    throw new Error(payload.reason || "No Meshrix.js MCP hub discovered.");
  }
  return payload;
}

const token: any = await readDoctorToken();
const signedDiscovery: any = await discoverSignedBaseUrl();
const baseUrl: any = String(signedDiscovery.baseUrl).replace(/\/+$/, "");
const target: any = String(argValue("--target", process.env.MESHRIX_MCP_TARGET || "")).trim();
const headers: any = token
  ? {
      "Content-Type": "application/json",
      "X-Meshrix.js-Api-Key": token,
      ...(target ? { "X-Meshrix.js-MCP-Target": target } : {})
    }
  : { "Content-Type": "application/json" };

const report: Record<string, any> = {
  baseUrl,
  signedDiscovery,
  discovery: null,
  initialize: null,
  toolsList: null,
  systemHealth: null,
  deviceManifest: null,
  orbStack: null
};

report.discovery = await jsonFetch(`${baseUrl}/api/mcp/discovery`);
report.initialize = await jsonFetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(mcpRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "meshrix-mcp-doctor", version: "1" }
  }))
});

if (token) {
  report.toolsList = await jsonFetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(mcpRequest("tools/list", {}, 2))
  });
	  report.systemHealth = await jsonFetch(`${baseUrl}/mcp`, {
	    method: "POST",
	    headers,
	    body: JSON.stringify(mcpRequest("tools/call", {
	      name: "meshrix.discovery",
	      arguments: {
	        apiVersion: "v0.0.1:mcp:interface-1",
	        operation: "system.health",
        input: {}
      }
    }, 3))
  });
} else {
  report.toolsList = {
    ok: false,
    status: 0,
    statusText: "not_configured",
    reason: "Set MESHRIX_MCP_TOKEN, use --token-env NAME, or use --token-stdin to verify tools/list."
  };
  report.systemHealth = {
    ok: false,
    status: 0,
    statusText: "not_configured",
    reason: "Set MESHRIX_MCP_TOKEN, use --token-env NAME, or use --token-stdin to verify tools/call system.health."
  };
}

report.deviceManifest = await readDeviceManifest();
const vmHealthUrl: any = String(report.discovery.payload?.mcpServers?.meshrix?.vmHttpUrl || "")
  .replace(/\/mcp$/, "/api/healthz");
report.orbStack = await checkConfiguredOrbStackTargets(vmHealthUrl);

const listedTools: any = report.toolsList.payload?.result?.tools || [];
const listedToolNames: any = new Set<any>(listedTools.map((tool?: any) : any => tool.name));
const hasStableOutlet: any = listedToolNames.has(MCP_STABLE_TOOL_NAME);
const hasValidOutletSet: any = hasStableOutlet && listedToolNames.size === listedTools.length;

const ok: any = report.signedDiscovery.ok
  && report.discovery.ok
  && report.initialize.ok
  && report.deviceManifest.ok
  && (!token || (
    report.toolsList.ok
    && hasValidOutletSet
    && report.systemHealth.ok
    && report.systemHealth.payload?.result?.structuredContent?.payload?.ok === true
  ));
console.log(JSON.stringify({
  ok,
  checks: {
    signedDiscovery: {
      ok: report.signedDiscovery.ok,
      baseUrl,
      identityKeyId: report.signedDiscovery.identityKeyId || "",
      attempts: report.signedDiscovery.attempts || []
    },
    discovery: {
      ok: report.discovery.ok,
      status: report.discovery.status,
      httpUrl: report.discovery.payload?.mcpServers?.meshrix?.httpUrl || "",
      vmHttpUrl: report.discovery.payload?.mcpServers?.meshrix?.vmHttpUrl || "",
      installerPackage: report.discovery.payload?.installer?.packageName || "",
      githubOneLineCommand: report.discovery.payload?.installer?.githubOneLineCommand || "",
      installerCommand: report.discovery.payload?.installer?.installCommand || "",
      interactiveInstallCommand: report.discovery.payload?.installer?.interactiveInstallCommand || "",
      clientInstallCommand: report.discovery.payload?.installer?.clientInstallCommand || "",
      discoverCommand: report.discovery.payload?.installer?.discoverCommand || "",
      scanCommand: report.discovery.payload?.installer?.scanCommand || "",
      localDiscoveryEntrypoint: report.discovery.payload?.localDiscovery?.entrypoint || null,
      localDiscoveryFiles: report.discovery.payload?.localDiscovery?.files || []
    },
    initialize: {
      ok: report.initialize.ok,
      status: report.initialize.status,
      serverName: report.initialize.payload?.result?.serverInfo?.name || "",
      serverVersion: report.initialize.payload?.result?.serverInfo?.version || "",
      listChanged: report.initialize.payload?.result?.capabilities?.tools?.listChanged === true,
      stableToolName: report.initialize.payload?.result?._meta?.stableToolName || ""
    },
    toolsList: {
      ok: report.toolsList.ok,
	      status: report.toolsList.status,
      configured: report.toolsList.statusText !== "not_configured",
	      toolCount: report.toolsList.payload?.result?.tools?.length || 0,
	      stableOutletSet: hasValidOutletSet,
	      reason: report.toolsList.reason || ""
	    },
    systemHealth: {
      ok: report.systemHealth.ok,
      status: report.systemHealth.status,
      configured: report.systemHealth.statusText !== "not_configured",
      healthy: report.systemHealth.payload?.result?.structuredContent?.payload?.ok === true,
      operation: report.systemHealth.payload?.result?.structuredContent?.operation || "",
      reason: report.systemHealth.reason || ""
    },
    deviceManifest: {
      ok: report.deviceManifest.ok,
      exists: report.deviceManifest.exists,
      pathRedacted: report.deviceManifest.pathRedacted === true,
      httpUrl: report.deviceManifest.httpUrl || "",
      vmHttpUrl: report.deviceManifest.vmHttpUrl || "",
      connector: report.deviceManifest.connector || null,
      installedTargets: report.deviceManifest.installedTargets || [],
      targetStatuses: Object.fromEntries((Object.entries(report.deviceManifest.targets || {}) as [string, any][]).map(([target, value]: any[]) : any => [
        target,
        value?.status || "unknown"
      ])),
      reason: report.deviceManifest.error || ""
    },
    orbStack: report.orbStack
  }
}, null, 2));

process.exit(ok ? 0 : 1);
