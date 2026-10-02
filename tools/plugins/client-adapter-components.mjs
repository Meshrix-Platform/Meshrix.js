import fs from "node:fs/promises";
import path from "node:path";

import { readJson, repoRoot } from "./lib/repository.mjs";

export const adapterTargets = Object.freeze(["antigravity", "claude-code", "codex", "kimi", "openclaw", "opencode", "pi"]);
export const kitRoot = path.join(repoRoot, "plugins", "agents", "client-adapter-kit");

export async function adapterDescriptors() {
  const registry = await readJson(path.join(repoRoot, "plugins", "registry", "plugins.json"));
  const entries = registry.plugins.filter((entry) => entry.adapter === true);
  if (entries.length !== adapterTargets.length) throw new Error("adapter catalog count mismatch");

  const rootPackage = await readJson(path.join(repoRoot, "package.json"));
  const bundled = new Set(rootPackage.bundleDependencies || []);
  const kitPackage = await readJson(path.join(kitRoot, "package.json"));
  const descriptors = [];
  for (const target of adapterTargets) {
    const entry = entries.find((candidate) => candidate.id === `agent-${target}`);
    if (!entry || entry.release !== false || entry.runtime !== false) {
      throw new Error(`Client adapter ${target} is still declared as a separate plugin release`);
    }
    const root = path.join(repoRoot, "plugins", "agents", target);
    const descriptor = await readJson(path.join(root, "adapter.json"));
    const packageJson = await readJson(path.join(root, "package.json"));
    if (descriptor.schemaVersion !== "v0.0.1:meshrix:client-adapter-descriptor-1" ||
        descriptor.protocol !== "v0.0.1:meshrix:client-adapter-json-stdio-1" || descriptor.target !== target ||
        descriptor.packageName !== packageJson.name || descriptor.version !== packageJson.version ||
        descriptor.entrypoint !== "adapter.mjs" || !packageJson.private ||
        packageJson.peerDependencies?.[kitPackage.name] !== kitPackage.version || packageJson.bin !== undefined ||
        !bundled.has(packageJson.name) ||
        entry.version !== packageJson.version ||
        JSON.stringify(entry.adapterContract) !== JSON.stringify({
          target,
          packageName: descriptor.packageName,
          entrypoint: descriptor.entrypoint,
          protocol: descriptor.protocol
        })) {
      throw new Error(`Client adapter ${target} component metadata is invalid`);
    }
    descriptors.push({ root, descriptor, packageJson });
  }
  if (!bundled.has(kitPackage.name)) throw new Error("Client adapter kit is not bundled with meshrix.js");
  return descriptors;
}
