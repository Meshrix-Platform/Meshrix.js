// Release journey client-adapter cache seeding.
//
// The connector installs client adapters from a verified local cache. The
// gate seeds that cache from a trusted source — the sibling Meshrix-Plugins
// checkout by default, or an explicit directory / tarball through
// MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE / --adapter-source — and validates
// the seeded adapter through the connector's own descriptor contract before
// the real install runs.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  describeClientAdapter,
  digestClientAdapterTree
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.mjs";
import { mcpClientAdapterForTarget } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.mjs";

export const DEFAULT_ADAPTER_SOURCE = "../Meshrix-Plugins/plugins/agents/kimi";
export const ADAPTER_KIT_PACKAGE = "@meshrix/client-adapter-kit";

function adapterCachePaths(cacheRoot, target, version) {
  return {
    root: path.join(cacheRoot, target, version),
    tree: path.join(cacheRoot, target, version, "tree"),
    metadata: path.join(cacheRoot, target, version, "cache.json")
  };
}

async function pathKind(candidate) {
  const stat = await fs.stat(candidate).catch(() => null);
  if (stat?.isDirectory()) return "dir";
  if (stat?.isFile() && /\.(?:tgz|tar\.gz)$/iu.test(candidate)) return "tgz";
  return "";
}

async function readPackageName(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8").catch(() => "{}"));
  return { name: String(manifest?.name || ""), version: String(manifest?.version || "") };
}

async function copyAdapterTree({ adapterDir, kitDir, treeRoot, adapterPackageName }) {
  const adapterTarget = path.join(treeRoot, "node_modules", ...adapterPackageName.split("/"));
  const kitTarget = path.join(treeRoot, "node_modules", ...ADAPTER_KIT_PACKAGE.split("/"));
  await fs.mkdir(adapterTarget, { recursive: true, mode: 0o700 });
  await fs.mkdir(kitTarget, { recursive: true, mode: 0o700 });
  await fs.cp(adapterDir, adapterTarget, { recursive: true });
  await fs.cp(kitDir, kitTarget, { recursive: true });
}

async function extractTarball(tarball, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    const error = new Error(`Failed to extract adapter source tarball: ${String(result.stderr || "").slice(-400)}`);
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }
}

async function locatePackages(root) {
  // Accepted layouts:
  //   <root>/package.json                              (the kimi adapter alone; kit expected as sibling)
  //   <root>/{kimi,client-adapter-kit}/                (plugins agents directory)
  //   <root>/node_modules/@meshrix/{agent-kimi-adapter,client-adapter-kit}/
  const direct = await readPackageName(root).catch(() => ({ name: "" }));
  if (direct.name) {
    return { adapterDir: direct.name === "@meshrix/agent-kimi-adapter" ? root : "", kitDir: direct.name === ADAPTER_KIT_PACKAGE ? root : "", root };
  }
  const candidates = [
    { adapterDir: path.join(root, "kimi"), kitDir: path.join(root, "client-adapter-kit") },
    {
      adapterDir: path.join(root, "node_modules", "@meshrix", "agent-kimi-adapter"),
      kitDir: path.join(root, "node_modules", "@meshrix", "client-adapter-kit")
    },
    {
      adapterDir: path.join(root, "plugins", "agents", "kimi"),
      kitDir: path.join(root, "plugins", "agents", "client-adapter-kit")
    }
  ];
  for (const candidate of candidates) {
    const adapter = await readPackageName(candidate.adapterDir).catch(() => ({ name: "" }));
    const kit = await readPackageName(candidate.kitDir).catch(() => ({ name: "" }));
    if (adapter.name === "@meshrix/agent-kimi-adapter" && kit.name === ADAPTER_KIT_PACKAGE) {
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
} = {}) {
  const trusted = mcpClientAdapterForTarget(target);
  if (!trusted) {
    const error = new Error(`Target ${target} is not trusted by this connector release.`);
    error.code = "release_journey_adapter_target_unsupported";
    throw error;
  }
  const source = String(adapterSource || process.env.MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE || "").trim()
    || path.join(repoRoot, DEFAULT_ADAPTER_SOURCE);
  const resolvedSource = path.resolve(repoRoot, source);
  const kind = await pathKind(resolvedSource);
  if (!kind) {
    const error = new Error(
      "Release journey adapter source not found. Provide the kimi client adapter via " +
      "MESHRIX_RELEASE_JOURNEY_ADAPTER_SOURCE or --adapter-source (directory or .tgz); " +
      `the default sibling checkout is missing at ${DEFAULT_ADAPTER_SOURCE}.`
    );
    error.code = "release_journey_adapter_source_missing";
    throw error;
  }

  let packagesRoot = resolvedSource;
  if (kind === "tgz") {
    packagesRoot = path.join(cacheRoot, ".adapter-source-extract");
    await fs.rm(packagesRoot, { recursive: true, force: true });
    await extractTarball(resolvedSource, packagesRoot);
  }
  const located = await locatePackages(packagesRoot);
  if (!located.adapterDir) {
    const error = new Error("Adapter source does not contain the @meshrix/agent-kimi-adapter package.");
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }
  let kitDir = located.kitDir;
  if (!kitDir) {
    // The kimi adapter depends on the shared kit; expect it next to the adapter.
    const sibling = path.join(path.dirname(located.adapterDir), "client-adapter-kit");
    const siblingManifest = await readPackageName(sibling).catch(() => ({ name: "" }));
    if (siblingManifest.name === ADAPTER_KIT_PACKAGE) {
      kitDir = sibling;
    }
  }
  if (!kitDir) {
    const error = new Error(`Adapter source does not contain the shared ${ADAPTER_KIT_PACKAGE} package.`);
    error.code = "release_journey_adapter_source_invalid";
    throw error;
  }

  const adapterManifest = await readPackageName(located.adapterDir);
  if (adapterManifest.name !== trusted.packageName || adapterManifest.version !== trusted.version) {
    const error = new Error(
      `Adapter package identity ${adapterManifest.name}@${adapterManifest.version} does not match the trusted coordinate ${trusted.coordinate}.`
    );
    error.code = "release_journey_adapter_coordinate_mismatch";
    throw error;
  }

  const paths = adapterCachePaths(cacheRoot, target, trusted.version);
  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.tree, { recursive: true, mode: 0o700 });
  await copyAdapterTree({
    adapterDir: located.adapterDir,
    kitDir,
    treeRoot: paths.tree,
    adapterPackageName: trusted.packageName
  });
  const sha256 = await digestClientAdapterTree(paths.tree);
  await fs.writeFile(path.join(paths.root, "cache.json"), JSON.stringify({
    schemaVersion: "v0.0.1:meshrix:client-adapter-cache-1",
    target,
    coordinate: trusted.coordinate,
    sha256
  }, null, 2));

  // Prove the adapter speaks the canonical protocol through the connector's
  // own contract check before the install path depends on it.
  const described = await describeClientAdapter({ target, cacheRoot });
  return {
    target,
    coordinate: trusted.coordinate,
    adapterSourceKind: kind,
    cacheSha256: sha256,
    descriptorOk: described.result?.target === target && described.result?.packageName === trusted.packageName
  };
}

export function resolveKimiClientCommand({ env = process.env } = {}) {
  // The adapter contract requires a local client command. Prefer the real
  // kimi binary; fall back to a no-op shim so CI runners without the CLI still
  // exercise the identical adapter contract (the gate drives the server over
  // the stdio proxy itself, so no LLM client is required).
  const probe = spawnSync("sh", ["-c", "command -v kimi || true"], { encoding: "utf8", env });
  const detected = probe.status === 0 ? probe.stdout.trim().split("\n")[0] : "";
  if (detected) {
    return { command: detected, source: "detected" };
  }
  return { command: "true", source: "shim" };
}
