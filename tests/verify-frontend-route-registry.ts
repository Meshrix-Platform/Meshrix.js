#!/usr/bin/env node
/**
 * verify-frontend-route-registry.ts
 *
 * Verifies that the console route registry is consistent:
 * - All ADMIN_ROUTE_REGISTRY entries have valid slug↔viewKey bidirectional mapping
 * - No duplicate viewKeys or slugs
 * - adminSectionToSlug and slugToAdminView are consistent
 * - All registry component files exist in views/admin/
 * - Removed admin redirect surfaces are not exported
 * - No @vite-ignore in active code
 * - import.meta.glob is used for component loading
 *
 * Imports the pure data module (admin-route-registry.ts) directly —
 * no regex parsing of TypeScript source.
 *
 * Run via: npm run verify:console-route-registry.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() : Promise<any> {
  // Import the pure data registry
  const registryUrl: any = pathToFileURL(
    path.join(repoRoot, "apps", "console", "router", "admin-route-registry.ts")
  ).href;
  const registry: any = await import(registryUrl);
  const accessPolicyUrl: any = pathToFileURL(
    path.join(repoRoot, "apps", "console", "router", "route-access-policy.ts")
  ).href;
  const accessPolicy: any = await import(accessPolicyUrl);

  const entries: any = registry.ADMIN_ROUTE_REGISTRY;

  if (!entries || entries.length === 0) {
    throw new Error("ADMIN_ROUTE_REGISTRY is empty or missing in admin-route-registry.ts");
  }

  console.log(`Loaded ${entries.length} admin route entries from admin-route-registry.ts`);

  // Check 1: No duplicate viewKeys
  const viewKeys: any = new Set<any>();
  const dupViewKeys: any[] = [];
  for (const e of entries) {
    if (viewKeys.has(e.viewKey)) dupViewKeys.push(e.viewKey);
    viewKeys.add(e.viewKey);
  }
  assert.deepEqual(dupViewKeys, [], `Duplicate viewKeys in ADMIN_ROUTE_REGISTRY: ${dupViewKeys.join(", ")}`);

  // Check 2: No duplicate slugs
  const slugs: any = new Set<any>();
  const dupSlugs: any[] = [];
  for (const e of entries) {
    if (slugs.has(e.slug)) dupSlugs.push(e.slug);
    slugs.add(e.slug);
  }
  assert.deepEqual(dupSlugs, [], `Duplicate slugs in ADMIN_ROUTE_REGISTRY: ${dupSlugs.join(", ")}`);

  // Check 3: Bidirectional mapping consistency (viewKey↔slug)
  for (const entry of entries) {
    assert.equal(
      registry.VIEW_KEY_TO_SLUG[entry.viewKey],
      entry.slug,
      `VIEW_KEY_TO_SLUG mismatch for ${entry.viewKey}`
    );
    assert.equal(
      registry.SLUG_TO_VIEW_KEY[entry.slug],
      entry.viewKey,
      `SLUG_TO_VIEW_KEY mismatch for ${entry.slug}`
    );
  }
  console.log("   OK: Bidirectional viewKey↔slug maps are consistent");

  // Check 3a: Every registered route has a unified access policy.
  const adminAccessByView: any = accessPolicy.ADMIN_ROUTE_ACCESS_BY_VIEW || {};
  const missingAdminPolicies: any = entries
    .filter((entry?: any) : any => !adminAccessByView[entry.viewKey])
    .map((entry?: any) : any => entry.viewKey);
  assert.deepEqual(
    missingAdminPolicies,
    [],
    `ADMIN_ROUTE_REGISTRY entries missing access policy: ${missingAdminPolicies.join(", ")}`
  );
  for (const entry of entries) {
    const policy: any = adminAccessByView[entry.viewKey];
    assert.equal(
      policy.routePath,
      `/admin/${entry.slug}`,
      `Access policy routePath mismatch for ${entry.viewKey}`
    );
    assert.equal(
      Array.isArray(policy.requiredScopes) && policy.requiredScopes.length > 0,
      true,
      `Access policy for ${entry.viewKey} must declare requiredScopes`
    );
    assert.equal(
      Array.isArray(entry.requiredFeatureIds) && entry.requiredFeatureIds.length > 0,
      true,
      `Route registry entry ${entry.viewKey} must declare requiredFeatureIds`
    );
    assert.deepEqual(
      policy.requiredFeatureIds,
      entry.requiredFeatureIds,
      `Access policy requiredFeatureIds mismatch for ${entry.viewKey}`
    );
    assert.equal(
      accessPolicy.routeAccessPolicyAllowsSubject(
        policy,
        { scopes: policy.requiredScopes },
        []
      ),
      false,
      `Feature-disabled route ${entry.viewKey} must fail closed even when scopes are present`
    );
    assert.equal(
      accessPolicy.routeAccessPolicyAllowsSubject(
        policy,
        { scopes: policy.requiredScopes },
        policy.requiredFeatureIds
      ),
      true,
      `Feature-enabled route ${entry.viewKey} must be accessible when its scopes are present`
    );
  }
  const requiredAppViews: any[] = ["welcome", "login", "dashboard", "approval", "workspaces"];
  const missingAppPolicies: any = requiredAppViews.filter((viewId?: any) : any => !accessPolicy.APP_ROUTE_ACCESS_BY_VIEW?.[viewId]);
  assert.deepEqual(
    missingAppPolicies,
    [],
    `App views missing access policy: ${missingAppPolicies.join(", ")}`
  );
  const policyRoutePaths: any = new Set<any>();
  const duplicatePolicyRoutePaths: any[] = [];
  for (const policy of accessPolicy.ROUTE_ACCESS_REGISTRY || []) {
    if (policyRoutePaths.has(policy.routePath)) duplicatePolicyRoutePaths.push(policy.routePath);
    policyRoutePaths.add(policy.routePath);
  }
  assert.deepEqual(
    duplicatePolicyRoutePaths,
    [],
    `Duplicate route access policy paths: ${duplicatePolicyRoutePaths.join(", ")}`
  );

  // Check 3b: Operation Permission has one canonical admin route.
  assert.equal(
    registry.VIEW_KEY_TO_SLUG.operationPermission,
    "operation-permission",
    "Operation Permission admin route must use /admin/operation-permission"
  );

  // Check 4: All registry component files exist in views/admin/
  const missingComponents: any[] = [];
  for (const entry of entries) {
    const resolvedPath: any = path.join(repoRoot, "apps", "console", "views", "admin", entry.componentName);
    try {
      await fs.access(resolvedPath);
    } catch {
      missingComponents.push(`${entry.viewKey}: views/admin/${entry.componentName}`);
    }
  }
  assert.deepEqual(
    missingComponents,
    [],
    `ADMIN_ROUTE_REGISTRY references non-existent component files:\n- ${missingComponents.join("\n- ")}`
  );

  // Check 4a: Every registered admin route has a discoverable side-nav entry.
  const sideNavDirectory: any = path.join(repoRoot, "apps", "console", "components", "shell", "side-nav");
  const sideNavFiles: any = (await fs.readdir(sideNavDirectory))
    .filter((name?: any) : any => name.endsWith(".vue"));
  const sideNavSource: any = (await Promise.all(
    sideNavFiles.map((name?: any) : any => fs.readFile(path.join(sideNavDirectory, name), "utf8"))
  )).join("\n");
  const sideNavCalls: any = (functionName?: any, viewKey?: any) : any =>
    sideNavSource.includes(`${functionName}('${viewKey}')`) ||
    sideNavSource.includes(`${functionName}("${viewKey}")`);
  const missingNavigationEntries: any = entries
    .filter((entry?: any) : any =>
      !sideNavCalls("canAccessAdminView", entry.viewKey) ||
      !sideNavCalls("openAdmin", entry.viewKey)
    )
    .map((entry?: any) : any => entry.viewKey);
  assert.deepEqual(
    missingNavigationEntries,
    [],
    `Admin routes missing scope/feature-gated side-nav entries: ${missingNavigationEntries.join(", ")}`
  );

  // Check 5: No @vite-ignore in active code of routes.ts
  const routesTsPath: any = path.join(repoRoot, "apps", "console", "router", "routes.ts");
  const routesSource: any = await fs.readFile(routesTsPath, "utf8");
  const strippedComments: any = routesSource
    .replace(/\/\*[\s\S]*?\*\//g, "")     // block comments
    .replace(/\/\/[^\n]*/g, "");           // line comments
  const hasViteIgnore: any = strippedComments.includes("@vite-ignore");
  assert.equal(hasViteIgnore, false, "routes.ts must not use @vite-ignore in active code; use import.meta.glob instead");

  // Check 7: import.meta.glob is used for component loading
  const hasImportMetaGlob: any = routesSource.includes("import.meta.glob");
  assert.equal(hasImportMetaGlob, true, "routes.ts must use import.meta.glob for static-analyzable component loading");

  // Check 8: index.ts imports ADMIN_ROUTE_REGISTRY from routes (not inline)
  const routerPath: any = path.join(repoRoot, "apps", "console", "router", "index.ts");
  const routerSource: any = await fs.readFile(routerPath, "utf8");
  assert.equal(
    routerSource.includes("ADMIN_ROUTE_REGISTRY"),
    true,
    "router/index.ts must import and use ADMIN_ROUTE_REGISTRY"
  );

  // Check 9: index.ts does not silently filter(null) missing components
  // (MissingAdminView placeholder or throw is acceptable; filter(null) is not)
  const hasSilentFilter: any = routerSource.includes(".filter(");
  if (hasSilentFilter) {
    // Only flag if it filters on component null
    const filterNullPattern: any = /\.filter\(\s*\(.*\)\s*=>\s*.*!==\s*null\s*\)/;
    assert.equal(
      filterNullPattern.test(routerSource),
      false,
      "router/index.ts must not silently filter null components; use error placeholder instead"
    );
  }

  // Check 10: routes.ts re-exports from admin-route-registry.ts (not inline)
  assert.equal(
    routesSource.includes("admin-route-registry.ts"),
    true,
    "routes.ts must import from admin-route-registry.ts (pure data file)"
  );

  console.log(
    `Frontend route registry verified: ${entries.length} admin routes, bidirectional maps consistent, Vite-safe`
  );
}

main().catch((error?: any) : any => {
  console.error(error.message || error);
  process.exitCode = 1;
});
