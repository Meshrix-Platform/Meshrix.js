// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTE REGISTRY — imported from pure data module
// ══════════════════════════════════════════════════════════════════════════════
//
// The canonical ADMIN_ROUTE_REGISTRY lives in admin-route-registry.ts (pure data).
// This file re-exports it along with Vite-specific component loaders.
// Verifiers import admin-route-registry.ts directly; the Vue router imports
// this file for the component loader.
//
// LAYER SEPARATION:
// - admin-route-registry.ts: pure data, safe to import by verifiers and tests.
// - routes.ts: Vite-static-analyzable component loader map + re-exports.
//   Built via import.meta.glob so Vite can tree-shake and bundle correctly.
//   Do NOT use import(/* @vite-ignore */ variablePath) — it breaks bundling.

import {
  ADMIN_ROUTE_REGISTRY,
  VIEW_KEY_TO_SLUG,
  SLUG_TO_VIEW_KEY,
} from "./admin-route-registry.ts";

// Re-export for consumers
export {
  ADMIN_ROUTE_REGISTRY,
  VIEW_KEY_TO_SLUG,
  SLUG_TO_VIEW_KEY,
};

/** Canonical admin view entry — mirrors admin-route-registry.ts schema */
export interface AdminRouteEntry {
  viewKey: string;
  slug: string;
  componentName: string;
  requiredScopes: readonly string[];
  requiredFeatureIds: readonly string[];
  section: string;
  description?: string;
}

// ─── Component Loaders (Vite-static-analyzable via import.meta.glob) ────────

/**
 * All admin view .vue components, statically analyzable by Vite.
 * import.meta.glob returns a Record<path, () => Promise<Component>>.
 * Vite resolves these at build time — no @vite-ignore needed.
 */
const _adminViewModules: any = import.meta.glob("../views/admin/*.vue");

/**
 * Resolves a component loader for a given admin route entry.
 * Returns undefined if the component file is not found in the glob map.
 */
export function resolveAdminComponent(viewKey: string): (() => Promise<unknown>) | undefined {
  const entry: any = ADMIN_ROUTE_REGISTRY.find((e?: any) : any => e.viewKey === viewKey);
  if (!entry) return undefined;
  const globKey: any = `../views/admin/${entry.componentName}`;
  return _adminViewModules[globKey];
}

// ─── Derived helpers ─────────────────────────────────────────────────────────

/** AdminSection is the set of all canonical view keys. */
export type AdminSection = typeof ADMIN_ROUTE_REGISTRY[number]["viewKey"];

/** Maps AdminView key to URL slug. */
export function adminSectionToSlug(section: string): string {
  if (VIEW_KEY_TO_SLUG[section]) return VIEW_KEY_TO_SLUG[section];
  return "storage";
}

/** Maps URL slug back to AdminView key. */
export function slugToAdminView(slug: string): string {
  return SLUG_TO_VIEW_KEY[slug] ?? "storage";
}

/** Maps AppView to its canonical route path. */
export function viewToPath(
  view: string,
  opts?: { tab?: string; adminSection?: string },
): string {
  switch (view) {
    case "dashboard":   return "/";
    case "approval":    return "/approval";
    case "workspaces":  return "/workspaces";
    case "admin":
      return `/admin/${adminSectionToSlug(opts?.adminSection ?? "storage")}`;
    default:            return "/";
  }
}
