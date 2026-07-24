/**
 * Source Layout Manifest
 *
 * This module derives its data from tools/registry/architecture-layout-manifest.mjs.
 *
 * It no longer independently maintains duplicate public facade/resource lists.
 * All facts flow from the architecture manifest; this module provides the
 * sourceLayoutModule / sourceLayoutPath / sourceLayoutPackageImports /
 * validateSourceLayoutPackageImports API for verifier and tooling consumers.
 *
 * When adding a new public module or resource, update the architecture
 * layout manifest first, then run:
 *   node tools/server-scripts/verify-layout-manifest-consistency.mjs
 */

import {
  PUBLIC_FACADES as _ARCH_PUBLIC_FACADES,
  PUBLIC_RESOURCES as _ARCH_PUBLIC_RESOURCES,
} from "./architecture-layout-manifest.mjs";

export const SOURCE_LAYOUT_MANIFEST_VERSION = "source-layout-manifest";

// ── Derive publicModules from architecture manifest ────────────────────────────

function _buildPublicModules() {
  const modules = Object.create(null);
  for (const facade of _ARCH_PUBLIC_FACADES) {
    modules[facade.moduleId] = Object.freeze({
      importSpecifier: facade.importSpecifier,
      facadePath: facade.facadePath,
    });
  }
  return Object.freeze(modules);
}

// ── Derive publicResources from architecture manifest ─────────────────────────

function _buildPublicResources() {
  const resources = Object.create(null);
  for (const res of _ARCH_PUBLIC_RESOURCES) {
    resources[res.resourceId] = Object.freeze({
      path: res.path,
    });
  }
  return Object.freeze(resources);
}

export const SOURCE_LAYOUT_MANIFEST = Object.freeze({
  version: SOURCE_LAYOUT_MANIFEST_VERSION,
  publicModules: _buildPublicModules(),
  publicResources: _buildPublicResources(),
});

// ── Existing API (unchanged signatures) ──────────────────────────────────────

export function sourceLayoutModule(moduleId) {
  const entry = SOURCE_LAYOUT_MANIFEST.publicModules[moduleId];
  if (!entry) {
    throw new Error(`Unknown source-layout module: ${moduleId}`);
  }
  return entry;
}

export function sourceLayoutPath(moduleId) {
  const moduleEntry = SOURCE_LAYOUT_MANIFEST.publicModules[moduleId];
  if (moduleEntry) {
    return moduleEntry.facadePath;
  }
  const resourceEntry = SOURCE_LAYOUT_MANIFEST.publicResources[moduleId];
  if (resourceEntry) {
    return resourceEntry.path;
  }
  throw new Error(`Unknown source-layout path: ${moduleId}`);
}

export function sourceLayoutPackageImports() {
  return Object.freeze(
    Object.fromEntries(
      Object.values(SOURCE_LAYOUT_MANIFEST.publicModules)
        .filter((entry) => entry.importSpecifier && entry.facadePath)
        .map((entry) => [entry.importSpecifier, `./${entry.facadePath}`])
    )
  );
}

export function validateSourceLayoutPackageImports(imports, { label = "package.json#imports" } = {}) {
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) {
    throw new Error(`${label} must define source-layout public module imports.`);
  }

  for (const [specifier, expectedTarget] of Object.entries(sourceLayoutPackageImports())) {
    if (imports[specifier] !== expectedTarget) {
      throw new Error(`${label}.${specifier} must be ${expectedTarget}; received ${imports[specifier] || "<missing>"}.`);
    }
  }

  return imports;
}
