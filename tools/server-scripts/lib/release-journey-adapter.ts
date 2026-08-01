// Release journey client-adapter cache seeding.
//
// The connector installs client adapters from a verified local cache. The
// gate seeds that cache from a trusted source — the sibling Meshrix-Plugins
// checkout by default, or an explicit directory / tarball through
// MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE / --adapter-source — and validates
// every seeded adapter through the connector's own descriptor contract before
// the real install matrix runs.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  describeClientAdapter,
  digestClientAdapterTree
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";
import { scanInstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/scan-candidates.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_SUPPORTED_TARGETS,
  mcpClientAdapterForTarget
} from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";

export const DEFAULT_ADAPTER_SOURCE: any = "../Meshrix-Plugins/plugins/agents";
export const ADAPTER_KIT_PACKAGE: any = "@meshrix/client-adapter-kit";

function adapterCachePaths(cacheRoot?: any, target?: any, version?: any) : any {
  return {
    root: path.join(cacheRoot, target, version),
    tree: path.join(cacheRoot, target, version, "tree"),
    metadata: path.join(cacheRoot, target, version, "cache.json")
  };
}

async function pathKind(candidate?: any) : Promise<any> {
  const stat: any = await fs.stat(candidate).catch(() : any => null);
  if (stat?.isDirectory()) return "dir";
  if (stat?.isFile() && /\.(?:tgz|tar\.gz)$/iu.test(candidate)) return "tgz";
  return "";
}

async function readPackageName(directory?: any) : Promise<any> {
  const manifest: any = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8").catch(() : any => "{}"));
  return { name: String(manifest?.name || ""), version: String(manifest?.version || "") };
}

async function copyAdapterTree({ adapterDir, kitDir, treeRoot, adapterPackageName }: Record<string, any>) : Promise<any> {
  const adapterTarget: any = path.join(treeRoot, "node_modules", ...adapterPackageName.split("/"));
  const kitTarget: any = path.join(treeRoot, "node_modules", ...ADAPTER_KIT_PACKAGE.split("/"));
  await fs.mkdir(adapterTarget, { recursive: true, mode: 0o700 });
  await fs.mkdir(kitTarget, { recursive: true, mode: 0o700 });
  await fs.cp(adapterDir, adapterTarget, { recursive: true });
  await fs.cp(kitDir, kitTarget, { recursive: true });
}

async function extractTarball(tarball?: any, destination?: any) : Promise<any> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const result: any = spawnSync("tar", ["-xzf", tarball, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    const error: Error & Record<string, any> = new Error(`Failed to extract adapter source tarball: ${String(result.stderr || "").slice(-400)}`);
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }
}

async function locatePackages(root: any, { target, adapterPackageName }: Record<string, any>) : Promise<any> {
  // Accepted layouts:
  //   <root>/package.json                             (one adapter; kit expected as sibling)
  //   <root>/{<target>,client-adapter-kit}/           (plugins agents directory)
  //   <root>/node_modules/<adapter package>           (packed dependency tree)
  const direct: any = await readPackageName(root).catch(() : any => ({ name: "" }));
  if (direct.name) {
    return {
      adapterDir: direct.name === adapterPackageName ? root : "",
      kitDir: direct.name === ADAPTER_KIT_PACKAGE ? root : "",
      root
    };
  }
  const candidates: any[] = [
    { adapterDir: path.join(root, target), kitDir: path.join(root, "client-adapter-kit") },
    {
      adapterDir: path.join(root, "node_modules", ...adapterPackageName.split("/")),
      kitDir: path.join(root, "node_modules", "@meshrix", "client-adapter-kit")
    },
    {
      adapterDir: path.join(root, "plugins", "agents", target),
      kitDir: path.join(root, "plugins", "agents", "client-adapter-kit")
    }
  ];
  for (const candidate of candidates) {
    const adapter: any = await readPackageName(candidate.adapterDir).catch(() : any => ({ name: "" }));
    const kit: any = await readPackageName(candidate.kitDir).catch(() : any => ({ name: "" }));
    if (adapter.name === adapterPackageName && kit.name === ADAPTER_KIT_PACKAGE) {
      return { adapterDir: candidate.adapterDir, kitDir: candidate.kitDir, root };
    }
  }
  return { adapterDir: direct.name ? root : "", kitDir: "", root };
}

export async function seedClientAdapterCache({
  repoRoot,
  target = "kimi",
  adapterSource = "",
  cacheRoot
}: Record<string, any> = {}) : Promise<any> {
  const trusted: any = mcpClientAdapterForTarget(target);
  if (!trusted) {
    const error: Error & Record<string, any> = new Error(`Target ${target} is not trusted by this connector release.`);
    error.code = "release_journey_adapter_target_unsupported";
    throw error;
  }
  const source: any = String(adapterSource || process.env.MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE || "").trim()
    || path.join(repoRoot, DEFAULT_ADAPTER_SOURCE);
  const resolvedSource: any = path.resolve(repoRoot, source);
  const kind: any = await pathKind(resolvedSource);
  if (!kind) {
    const error: Error & Record<string, any> = new Error(
      "Release journey adapter source not found. Provide the client adapter packages via " +
      "MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE or --adapter-source (directory or .tgz); " +
      `the default sibling checkout is missing at ${DEFAULT_ADAPTER_SOURCE}.`
    );
    error.code = "release_journey_adapter_source_missing";
    throw error;
  }

  let packagesRoot: any = resolvedSource;
  if (kind === "tgz") {
    packagesRoot = path.join(cacheRoot, ".adapter-source-extract");
    await fs.rm(packagesRoot, { recursive: true, force: true });
    await extractTarball(resolvedSource, packagesRoot);
  }
  const located: any = await locatePackages(packagesRoot, {
    target,
    adapterPackageName: trusted.packageName
  });
  if (!located.adapterDir) {
    const error: Error & Record<string, any> = new Error("Adapter source does not contain the trusted target package.");
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }
  let kitDir: any = located.kitDir;
  if (!kitDir) {
    // Every client adapter depends on the shared kit; expect it next to the adapter.
    const sibling: any = path.join(path.dirname(located.adapterDir), "client-adapter-kit");
    const siblingManifest: any = await readPackageName(sibling).catch(() : any => ({ name: "" }));
    if (siblingManifest.name === ADAPTER_KIT_PACKAGE) {
      kitDir = sibling;
    }
  }
  if (!kitDir) {
    const error: Error & Record<string, any> = new Error(`Adapter source does not contain the shared ${ADAPTER_KIT_PACKAGE} package.`);
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }

  const adapterManifest: any = await readPackageName(located.adapterDir);
  if (adapterManifest.name !== trusted.packageName || adapterManifest.version !== trusted.version) {
    const error: Error & Record<string, any> = new Error(
      `Adapter package identity ${adapterManifest.name}@${adapterManifest.version} does not match the trusted coordinate ${trusted.coordinate}.`
    );
    error.code = "release_journey_adapter_coordinate_mismatch";
    throw error;
  }

  const paths: any = adapterCachePaths(cacheRoot, target, trusted.version);
  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.tree, { recursive: true, mode: 0o700 });
  await copyAdapterTree({
    adapterDir: located.adapterDir,
    kitDir,
    treeRoot: paths.tree,
    adapterPackageName: trusted.packageName
  });
  const sha256: any = await digestClientAdapterTree(paths.tree);
  await fs.writeFile(path.join(paths.root, "cache.json"), JSON.stringify({
    schemaVersion: "v0.0.1:meshrix:client-adapter-cache-1",
    target,
    coordinate: trusted.coordinate,
    sha256
  }, null, 2));

  // Prove the adapter speaks the canonical protocol through the connector's
  // own contract check before the install path depends on it.
  const described: any = await describeClientAdapter({ target, cacheRoot });
  return {
    target,
    coordinate: trusted.coordinate,
    adapterSourceKind: kind,
    cacheSha256: sha256,
    descriptorOk: described.result?.target === target && described.result?.packageName === trusted.packageName
  };
}

export async function seedClientAdapterCaches({
  repoRoot,
  adapterSource = "",
  cacheRoot,
  targets = MCP_SUPPORTED_TARGETS
}: Record<string, any> = {}) : Promise<any> {
  const receipts: any[] = [];
  for (const target of targets) {
    receipts.push(await seedClientAdapterCache({
      repoRoot,
      target,
      adapterSource,
      cacheRoot
    }));
  }
  return receipts;
}

export async function discoverReleaseJourneyClients({
  cacheRoot,
  baseUrl,
  scanTargets = scanInstallTargets,
  fallbackCommand = process.execPath
}: Record<string, any> = {}) : Promise<any> {
  const scan: any = await scanTargets({
    "adapter-cache": cacheRoot,
    "resolved-url": baseUrl
  });
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
