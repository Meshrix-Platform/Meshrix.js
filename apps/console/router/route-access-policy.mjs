/**
 * ROUTE ACCESS POLICY REGISTRY — pure data + policy helpers.
 *
 * Route visibility is capability driven. Roles such as owner/admin/operator/viewer
 * are only server-side configuration bundles that resolve to scopes; the UI asks
 * whether the current subject satisfies a route policy.
 */

import { ADMIN_ROUTE_REGISTRY } from "./admin-route-registry.mjs";

/** @type {ReadonlyArray<{ viewId: string, routePath: string, requiredScopes?: string[], requiredFeatureIds?: string[], public?: boolean }>} */
export const APP_ROUTE_ACCESS_REGISTRY = Object.freeze([
  { viewId: "welcome", routePath: "/welcome", public: true },
  { viewId: "login", routePath: "/login", public: true },
  { viewId: "dashboard", routePath: "/", requiredScopes: ["console:read"] },
  { viewId: "approval", routePath: "/approval", requiredScopes: ["console:read"], requiredFeatureIds: ["operation-permission-core"] },
  { viewId: "workspaces", routePath: "/workspaces", requiredScopes: ["workspace:read"], requiredFeatureIds: ["agent-workspace-core"] },
]);

/** @type {ReadonlyArray<{ adminView: string, routePath: string, requiredScopes: string[], requiredFeatureIds: string[] }>} */
export const ADMIN_ROUTE_ACCESS_REGISTRY = Object.freeze(ADMIN_ROUTE_REGISTRY.map((entry) => Object.freeze({
  adminView: entry.viewKey,
  routePath: `/admin/${entry.slug}`,
  requiredScopes: [...entry.requiredScopes],
  requiredFeatureIds: [...entry.requiredFeatureIds]
})));

export const ROUTE_ACCESS_REGISTRY = Object.freeze([
  ...APP_ROUTE_ACCESS_REGISTRY,
  ...ADMIN_ROUTE_ACCESS_REGISTRY,
]);

export const APP_ROUTE_ACCESS_BY_VIEW = Object.freeze(
  Object.fromEntries(APP_ROUTE_ACCESS_REGISTRY.map((entry) => [entry.viewId, Object.freeze({ ...entry })]))
);

export const ADMIN_ROUTE_ACCESS_BY_VIEW = Object.freeze(
  Object.fromEntries(ADMIN_ROUTE_ACCESS_REGISTRY.map((entry) => [entry.adminView, Object.freeze({ ...entry })]))
);

export const ROUTE_ACCESS_BY_PATH = Object.freeze(
  Object.fromEntries(ROUTE_ACCESS_REGISTRY.map((entry) => [entry.routePath, Object.freeze({ ...entry })]))
);

function stringList(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function subjectScopes(subject = {}) {
  if (Array.isArray(subject)) {
    return stringList(subject);
  }
  return stringList([
    ...(Array.isArray(subject.scopes) ? subject.scopes : []),
    ...(Array.isArray(subject.user?.scopes) ? subject.user.scopes : []),
  ]);
}

export function routeAccessPolicyForView(viewId = "") {
  return APP_ROUTE_ACCESS_BY_VIEW[String(viewId || "")] || null;
}

export function routeAccessPolicyForAdminView(adminView = "") {
  return ADMIN_ROUTE_ACCESS_BY_VIEW[String(adminView || "")] || null;
}

export function routeAccessPolicyForPath(routePath = "") {
  return ROUTE_ACCESS_BY_PATH[String(routePath || "")] || null;
}

export function routeAccessPolicyAllowsSubject(policy = null, subject = {}, activeFeatureIds = []) {
  if (!policy || policy.public === true) {
    return true;
  }
  const requiredScopes = stringList(policy.requiredScopes || []);
  const scopeSet = new Set(subjectScopes(subject));
  if (!requiredScopes.every((scope) => scopeSet.has(scope))) {
    return false;
  }
  const featureSet = new Set(stringList(activeFeatureIds));
  return stringList(policy.requiredFeatureIds || []).every((featureId) => featureSet.has(featureId));
}

export function canAccessView(viewId = "", subject = {}, activeFeatureIds = []) {
  return routeAccessPolicyAllowsSubject(routeAccessPolicyForView(viewId), subject, activeFeatureIds);
}

export function canAccessAdminView(adminView = "", subject = {}, activeFeatureIds = []) {
  return routeAccessPolicyAllowsSubject(routeAccessPolicyForAdminView(adminView), subject, activeFeatureIds);
}

export function firstAccessibleRoutePath(subject = {}, activeFeatureIds = []) {
  const first = ROUTE_ACCESS_REGISTRY.find((entry) =>
    entry.public !== true && routeAccessPolicyAllowsSubject(entry, subject, activeFeatureIds)
  );
  return first?.routePath || "/welcome";
}
