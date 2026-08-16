// Component ownership-tier test (Node N19 / REQ-020; design artifact
// component-tiers.md section 6). Drives the SAME enumeration the reuse gate uses
// (tools/server-scripts/verify-console-component-reuse.ts, Family 3): a recursive
// walk of the components directory plus text scans of common.ts (registry entry
// blocks carrying a `tier` field) and feature-registry.ts (component path
// literals), with the gate's own regexes. Every components file must resolve to
// exactly one tier: Tier 2 at the root (common.ts), Tier 3 under a feature
// subdirectory (feature-registry.ts). Tier 1 primitives live in packages/ui-console
// and are declared by their package import — outside this enumeration by design.
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  componentFeatureIdVocabulary,
  componentFeatureRegistry,
} from "../../../apps/console/components/feature-registry";

const repoRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const componentsRoot: string = "apps/console/components";
const rootPrefix: string = `${componentsRoot}/`;
const commonModulePath: string = `${componentsRoot}/common.ts`;
const featureRegistryModulePath: string = `${componentsRoot}/feature-registry.ts`;

// Gate mirror (verify-console-component-reuse.ts Family 3): entry blocks with a
// `file:` literal, tier-marked; and feature path literals anywhere in the module.
const registryEntryBlockPattern: RegExp = /\{[^{}]*\bfile:\s*"([^"]+)"[^{}]*\}/gu;
const tierFieldPattern: RegExp = /\btier\s*:/u;
const featurePathPattern: RegExp = /["'`]((?:apps\/console\/)?components\/[^"'`]+\.vue)["'`]/gu;

async function walk(relativeDir: string, extensions: RegExp): Promise<string[]> {
  const absoluteDir = path.join(repoRoot, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(relativePath, extensions)));
    } else if (extensions.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function normalizeComponentPath(value: string): string {
  return value.startsWith("apps/console/") ? value : `apps/console/${value}`;
}

async function declaredTier2Paths(): Promise<Set<string>> {
  const source = await fs
    .readFile(path.join(repoRoot, commonModulePath), "utf8")
    .catch(() => null);
  const declared = new Set<string>();
  if (source !== null) {
    for (const match of source.matchAll(registryEntryBlockPattern)) {
      if (!tierFieldPattern.test(match[0])) {
        continue;
      }
      const declaredPath = normalizeComponentPath(match[1]);
      if (declaredPath.endsWith(".vue")) {
        declared.add(declaredPath);
      }
    }
  }
  return declared;
}

async function declaredTier3Paths(): Promise<Set<string>> {
  const source = await fs
    .readFile(path.join(repoRoot, featureRegistryModulePath), "utf8")
    .catch(() => null);
  const declared = new Set<string>();
  if (source !== null) {
    for (const match of source.matchAll(featurePathPattern)) {
      declared.add(normalizeComponentPath(match[1]));
    }
  }
  return declared;
}

/** Tier-3 boundary rule (design section 3): a Tier-3 component may be imported only
 *  by modules under the owning feature's component directories or the feature's views.
 *  A feature's component directories are the directories of the components registered
 *  to it (nested features own their registered directory, e.g. "agent-config" owns
 *  components/admin/agent-config/). */
function isAllowedTier3Import(fromFile: string, toFile: string): boolean {
  const target = componentFeatureRegistry.find((entry) => entry.path === toFile);
  if (!target) {
    return true; // non-Tier-3 targets are not governed by the boundary
  }
  if (fromFile.startsWith(`apps/console/views/${target.feature}/`)) {
    return true;
  }
  const ownerDirectories = new Set(
    componentFeatureRegistry
      .filter((entry) => entry.feature === target.feature)
      .map((entry) => path.dirname(entry.path)),
  );
  return [...ownerDirectories].some((directory) => fromFile.startsWith(`${directory}/`));
}

describe("console component tiers", () => {
  it("resolves every components .vue file to exactly one tier (gate enumeration)", async () => {
    const files = (await walk(componentsRoot, /\.vue$/u)).sort();
    const tier2 = await declaredTier2Paths();
    const tier3 = await declaredTier3Paths();

    expect(files.length).toBeGreaterThan(0);
    const rootFiles = files.filter((file) => !file.slice(rootPrefix.length).includes("/"));
    const subdirFiles = files.filter((file) => file.slice(rootPrefix.length).includes("/"));

    // Root components are Tier 2 (common.ts), never Tier 3.
    for (const file of rootFiles) {
      expect(tier2.has(file), `${file} must be declared Tier 2 in ${commonModulePath}`).toBe(true);
      expect(tier3.has(file), `${file} must not be declared Tier 3`).toBe(false);
    }
    // Subdirectory components are Tier 3 (feature-registry.ts), never Tier 2.
    for (const file of subdirFiles) {
      expect(tier3.has(file), `${file} must be declared Tier 3 in ${featureRegistryModulePath}`).toBe(true);
      expect(tier2.has(file), `${file} must not be declared Tier 2`).toBe(false);
    }
    // No path-keyed declaration names a file that no longer exists (path registry invariant).
    const onDisk = new Set(files);
    for (const declared of [...tier2, ...tier3]) {
      if (onDisk.has(declared) || declared.startsWith("apps/console/packages/")) {
        continue; // Tier 1 package entries normalize outside the components root
      }
      expect.fail(`declared tier path no longer exists on disk: ${declared}`);
    }
  });

  it("keeps the imported feature registry in agreement with the gate's text scan", async () => {
    const scanned = await declaredTier3Paths();
    const imported = new Set(componentFeatureRegistry.map((entry) => entry.path));
    expect([...imported].sort()).toEqual([...scanned].sort());
  });

  it("uses non-empty feature ids drawn from the frozen vocabulary", () => {
    expect(componentFeatureIdVocabulary.length).toBeGreaterThan(0);
    const vocabulary = new Set(componentFeatureIdVocabulary);
    expect(componentFeatureRegistry.length).toBeGreaterThan(0);
    for (const entry of componentFeatureRegistry) {
      expect(entry.path.startsWith(`${componentsRoot}/`)).toBe(true);
      expect(entry.feature.length).toBeGreaterThan(0);
      expect(vocabulary.has(entry.feature), `feature "${entry.feature}" is not in the frozen vocabulary`).toBe(true);
      // Feature ids are derived mechanically from the immediate parent directory name.
      const relative = entry.path.slice(rootPrefix.length);
      expect(relative.includes("/")).toBe(true);
      const parent = relative.split("/").slice(-2, -1)[0];
      expect(entry.feature).toBe(parent);
    }
  });

  it("rejects a cross-feature Tier-3 import fixture", () => {
    // shell importer -> admin component: different owning features.
    expect(
      isAllowedTier3Import(
        "apps/console/components/shell/ConsoleDrawer.vue",
        "apps/console/components/admin/AuthorizationGovernanceCard.vue",
      ),
    ).toBe(false);
    // Directional on the target's feature: the admin importer -> shell component also fails.
    expect(
      isAllowedTier3Import(
        "apps/console/components/admin/AuthorizationGovernanceCard.vue",
        "apps/console/components/shell/ConsoleDrawer.vue",
      ),
    ).toBe(false);
    // workspaces importer -> workspaces/detail component: sibling sub-features do not share.
    expect(
      isAllowedTier3Import(
        "apps/console/components/workspaces/WorkspaceDetailPanel.vue",
        "apps/console/components/workspaces/detail/WorkspaceAssetPanel.vue",
      ),
    ).toBe(false);
  });

  it("allows same-feature and feature-views Tier-3 import fixtures", () => {
    // The owning feature's views directory (views/admin exists for feature "admin").
    expect(
      isAllowedTier3Import(
        "apps/console/views/admin/ProductionHealthView.vue",
        "apps/console/components/admin/AuthorizationGovernanceCard.vue",
      ),
    ).toBe(true);
    // Same owning feature (detail).
    expect(
      isAllowedTier3Import(
        "apps/console/components/workspaces/detail/WorkspaceAssetPanel.vue",
        "apps/console/components/workspaces/detail/WorkspaceProfilePanel.vue",
      ),
    ).toBe(true);
  });
});
