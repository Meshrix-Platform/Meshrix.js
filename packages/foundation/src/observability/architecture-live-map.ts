import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionHealthReport } from "./report-reader.ts";

export const ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION: any = "v0.0.1:platform:architecture-live-map-1";

const defaultRepoRoot: any = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const ARCHITECTURE_NODES: readonly any[] = Object.freeze([
  {
    nodeId: "workspace-asset-governance",
    label: "Workspace Asset Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/functionality/WORKSPACE-ASSETS.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/agents/src/workspace-contribution/index.ts",
      "packages/agents/src/workspace-governance/index.ts"
    ],
    gateIds: ["workspace-contribution-governance", "workspace-governance"]
  },
  {
    nodeId: "gateway-governance",
    label: "Gateway Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/functionality/OPERATION-PERMISSION.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/capabilities/src/operation-permission-core/index.ts",
      "packages/protocols/mcp/adapter/http-mcp-adapter.ts"
    ],
    gateIds: ["gateway-access", "operation-permission", "approval-workflow"]
  },
  {
    nodeId: "version-control",
    label: "Version Governance",
    docRefs: [
      "docs/architecture/ARCHITECTURE.md",
      "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "packages/foundation/src/version-control/README.md",
      "packages/foundation/src/version-control/version-registry.json",
      "packages/foundation/src/version-control/version-registry.schema.json",
      "packages/foundation/src/version-control/version-scan.ts",
      "tools/server-scripts/verify-version-registry.ts",
      "tools/server-scripts/verify-version-naming.ts"
    ],
    gateIds: ["architecture", "version-registry", "version-naming"]
  },
  {
    nodeId: "production-readiness",
    label: "Production Readiness",
    docRefs: [
            "docs/protocols/PROTOCOLS.md"
    ],
    implementationPaths: [
      "tools/server-scripts/production-readiness-gate.ts",
      "packages/foundation/src/observability/readiness-baseline/report-reader.ts",
      "packages/foundation/src/observability/readiness-baseline/executive-report.ts"
    ],
    gateIds: ["architecture", "executive-report", "traffic-control"]
  }
]);

function text(value?: any) : any {
  return String(value ?? "").trim();
}

async function pathExists(repoRoot?: any, relativePath?: any) : Promise<any> {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function gateStatus(gatesById?: any, gateIds: any = []) : any {
  const statuses: any = gateIds.map((gateId?: any) : any => text(gatesById.get(gateId)?.status || "missing"));
  if (statuses.includes("fail") || statuses.includes("timeout") || statuses.includes("blocked")) return "blocked";
  if (statuses.includes("missing")) return "partial";
  if (statuses.every((status?: any) : any => status === "pass")) return "pass";
  return statuses[0] || "missing";
}

export async function buildArchitectureLiveMap(options: Record<string, any> = {}) : Promise<any> {
  const repoRoot: any = options.repoRoot || defaultRepoRoot;
  const productionHealth: any = options.productionHealth || await buildProductionHealthReport({
    repoRoot,
    reportRoot: options.reportRoot
  });
  const gatesById: any = new Map<any, any>((productionHealth.gates || []).map((gate?: any) : any => [gate.id, gate]));
  const nodes: any[] = [];
  for (const node of ARCHITECTURE_NODES) {
    const docRefs: any = await Promise.all(node.docRefs.map(async (docPath?: any) : Promise<any> => ({
      path: docPath,
      exists: await pathExists(repoRoot, docPath)
    })));
    const implementationPaths: any = await Promise.all(node.implementationPaths.map(async (implPath?: any) : Promise<any> => ({
      path: implPath,
      exists: await pathExists(repoRoot, implPath)
    })));
    const gates: any = node.gateIds.map((gateId?: any) : any => ({
      gateId,
      status: text(gatesById.get(gateId)?.status || "missing"),
      title: text(gatesById.get(gateId)?.title || gateId),
      nextStep: text(gatesById.get(gateId)?.nextStep || "")
    }));
    const missingDocs: any = docRefs.filter((item?: any) : any => !item.exists).map((item?: any) : any => item.path);
    const missingImplementations: any = implementationPaths.filter((item?: any) : any => !item.exists).map((item?: any) : any => item.path);
    const status: any = missingDocs.length || missingImplementations.length
      ? "partial"
      : gateStatus(gatesById, node.gateIds);
    nodes.push({
      protocolVersion: ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION,
      nodeId: node.nodeId,
      label: node.label,
      status,
      docRefs,
      implementationPaths,
      gates,
      missingDocs,
      missingImplementations
    });
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: ARCHITECTURE_LIVE_MAP_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    productionStatus: text(productionHealth.status || "missing"),
    nodes,
    summary: {
      total: nodes.length,
      pass: nodes.filter((node?: any) : any => node.status === "pass").length,
      partial: nodes.filter((node?: any) : any => node.status === "partial").length,
      blocked: nodes.filter((node?: any) : any => node.status === "blocked").length,
      missingDocs: nodes.reduce((sum?: any, node?: any) : any => sum + node.missingDocs.length, 0),
      missingImplementations: nodes.reduce((sum?: any, node?: any) : any => sum + node.missingImplementations.length, 0)
    }
  };
}
