export type RouteAccessPolicy = {
  viewId?: string;
  adminView?: string;
  routePath: string;
  requiredScopes?: string[];
  requiredFeatureIds?: string[];
  public?: boolean;
};

export const APP_ROUTE_ACCESS_REGISTRY: ReadonlyArray<RouteAccessPolicy & { viewId: string }>;
export const ADMIN_ROUTE_ACCESS_REGISTRY: ReadonlyArray<RouteAccessPolicy & { adminView: string }>;
export const ROUTE_ACCESS_REGISTRY: ReadonlyArray<RouteAccessPolicy>;
export const APP_ROUTE_ACCESS_BY_VIEW: Readonly<Record<string, RouteAccessPolicy>>;
export const ADMIN_ROUTE_ACCESS_BY_VIEW: Readonly<Record<string, RouteAccessPolicy>>;
export const ROUTE_ACCESS_BY_PATH: Readonly<Record<string, RouteAccessPolicy>>;

export function subjectScopes(subject?: unknown): string[];
export function routeAccessPolicyForView(viewId?: string): RouteAccessPolicy | null;
export function routeAccessPolicyForAdminView(adminView?: string): RouteAccessPolicy | null;
export function routeAccessPolicyForPath(routePath?: string): RouteAccessPolicy | null;
export function routeAccessPolicyAllowsSubject(policy?: RouteAccessPolicy | null, subject?: unknown, activeFeatureIds?: string[]): boolean;
export function canAccessView(viewId?: string, subject?: unknown, activeFeatureIds?: string[]): boolean;
export function canAccessAdminView(adminView?: string, subject?: unknown, activeFeatureIds?: string[]): boolean;
export function firstAccessibleRoutePath(subject?: unknown, activeFeatureIds?: string[]): string;
