import { scanInstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/scan-candidates.ts";
import { describeClientAdapter } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_SUPPORTED_TARGETS
} from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";

export async function verifyClientAdapterComponents({
  targets = MCP_SUPPORTED_TARGETS,
  describe = describeClientAdapter
}: Record<string, any> = {}) : Promise<any> {
  const receipts: any[] = [];
  for (const target of targets) {
    const result: any = await describe({ target });
    receipts.push({
      target,
      packageName: result.adapter.packageName,
      version: result.adapter.version,
      descriptorOk: result.result?.target === target && result.result?.packageName === result.adapter.packageName
    });
  }
  return {
    catalogTargetCount: receipts.length,
    descriptorCount: receipts.filter((receipt?: any) : any => receipt.descriptorOk).length,
    targets: receipts
  };
}

export async function discoverReleaseJourneyClients({
  baseUrl,
  scanTargets = scanInstallTargets,
  fallbackCommand = process.execPath
}: Record<string, any> = {}) : Promise<any> {
  const scan: any = await scanTargets({ "resolved-url": baseUrl });
  const candidateByTarget: any = new Map<any, any>(scan.candidates.map((candidate?: any) : any => [candidate.target, candidate]));
  const catalog: any = MCP_CLIENT_TARGETS.map(({ target, label }: Record<string, any>) : any => {
    const candidate: any = candidateByTarget.get(target);
    const command: any = String(candidate?.optionOverrides?.__meshrixAdapterClient?.command || "");
    const detected: any = candidate?.status === "detected" && command.length > 0;
    return {
      target,
      label,
      status: detected ? "detected" : "not_detected",
      command: detected ? command : ""
    };
  });
  const detected: any = catalog.filter((entry?: any) : any => entry.status === "detected");
  const fallback: any = detected.length === 0
    ? {
        target: "kimi",
        reportTarget: "mcp-simulator",
        label: "MCP protocol simulation fallback",
        command: fallbackCommand,
        validationMode: "simulated-fallback"
      }
    : null;
  return {
    detected,
    fallback,
    report: catalog.map(({ command: _command, ...entry }: Record<string, any>) : any => entry)
  };
}
