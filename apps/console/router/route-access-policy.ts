/**
 * ROUTE ACCESS POLICY REGISTRY — pure data + policy helpers.
 *
 * Route visibility is capability driven. Roles such as owner/admin/operator/viewer
 * are only server-side configuration bundles that resolve to scopes; the UI asks
 * whether the current subject satisfies a route policy.
 */

import { ADMIN_ROUTE_REGISTRY } from "./admin-route-registry.ts";

/** @type {ReadonlyArray<{ viewId: string, routePath: string, requiredScopes?: string[], requiredFeatureIds?: string[], public?: boolean }>} */
export const APP_ROUTE_ACCESS_REGISTRY: readonly any[] = Object.freeze([
  { viewId: "welcome", routePath: "/welcome", public: true },
  { viewId: "login", routePath: "/login", public: true },
  { viewId: "dashboard", routePath: "/", requiredScopes: ["console:read"] },
  { viewId: "approval", routePath: "/approval", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"] },
  { viewId: "workspaces", routePath: "/workspaces", requiredScopes: ["workspace:read"], requiredFeatureIds: ["agent-workspace-core"] },
]);

/** @type {ReadonlyArray<{ adminView: string, routePath: string, requiredScopes: string[], requiredFeatureIds: string[] }>} */
export const ADMIN_ROUTE_ACCESS_REGISTRY: any = Object.freeze(ADMIN_ROUTE_REGISTRY.map((entry?: any) : any => Object.freeze({
  adminView: entry.viewKey,
  routePath: `/admin/${entry.slug}`,
  requiredScopes: [...entry.requiredScopes],
  requiredFeatureIds: [...entry.requiredFeatureIds]
})));

export const ROUTE_ACCESS_REGISTRY: readonly any[] = Object.freeze([
  ...APP_ROUTE_ACCESS_REGISTRY,
  ...ADMIN_ROUTE_ACCESS_REGISTRY,
]);

export const APP_ROUTE_ACCESS_BY_VIEW: any = Object.freeze(
  Object.fromEntries(APP_ROUTE_ACCESS_REGISTRY.map((entry?: any) : any => [entry.viewId, Object.freeze({ ...entry })]))
);

export const ADMIN_ROUTE_ACCESS_BY_VIEW: any = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_ACCESS_REGISTRY.map((entry?: any) : any => [entry.adminView, Object.freeze({ ...entry })]))
);

export const ROUTE_ACCESS_BY_PATH: any = Object.freeze(
  Object.fromEntries(ROUTE_ACCESS_REGISTRY.map((entry?: any) : any => [entry.routePath, Object.freeze({ ...entry })]))
);

function stringList(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function subjectScopes(subject: Record<string, any> = {}) : any {
  if (Array.isArray(subject)) {
    return stringList(subject);
  }
  return stringList([
    ...(Array.isArray(subject.scopes) ? subject.scopes : []),
    ...(Array.isArray(subject.user?.scopes) ? subject.user.scopes : []),
  ]);
}

export function routeAccessPolicyForView(viewId: any = "") : any {
  return APP_ROUTE_ACCESS_BY_VIEW[String(viewId || "")] || null;
}

export function routeAccessPolicyForAdminView(adminView: any = "") : any {
  return ADMIN_ROUTE_ACCESS_BY_VIEW[String(adminView || "")] || null;
}

export function routeAccessPolicyForPath(routePath: any = "") : any {
  return ROUTE_ACCESS_BY_PATH[String(routePath || "")] || null;
}

export function routeAccessPolicyAllowsSubject(policy: any = null, subject: Record<string, any> = {}, activeFeatureIds: any = []) : any {
  if (!policy || policy.public === true) {
    return true;
  }
  const requiredScopes: any = stringList(policy.requiredScopes || []);
  const scopeSet: any = new Set<any>(subjectScopes(subject));
  if (!requiredScopes.every((scope?: any) : any => scopeSet.has(scope))) {
    return false;
  }
  const featureSet: any = new Set<any>(stringList(activeFeatureIds));
  return stringList(policy.requiredFeatureIds || []).every((featureId?: any) : any => featureSet.has(featureId));
}

export function canAccessView(viewId: any = "", subject: Record<string, any> = {}, activeFeatureIds: any = []) : any {
  return routeAccessPolicyAllowsSubject(routeAccessPolicyForView(viewId), subject, activeFeatureIds);
}

export function canAccessAdminView(adminView: any = "", subject: Record<string, any> = {}, activeFeatureIds: any = []) : any {
  return routeAccessPolicyAllowsSubject(routeAccessPolicyForAdminView(adminView), subject, activeFeatureIds);
}

export function firstAccessibleRoutePath(subject: Record<string, any> = {}, activeFeatureIds: any = []) : any {
  const first: any = ROUTE_ACCESS_REGISTRY.find((entry?: any) : any =>
    entry.public !== true && routeAccessPolicyAllowsSubject(entry, subject, activeFeatureIds)
  );
  return first?.routePath || "/welcome";
}
