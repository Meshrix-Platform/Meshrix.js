export interface AdminRouteEntry {
  viewKey: string;
  slug: string;
  componentName: string;
  requiredScopes: string[];
  requiredFeatureIds: string[];
  section: string;
  description?: string;
}

export const ADMIN_ROUTE_REGISTRY: ReadonlyArray<AdminRouteEntry>;

export const VIEW_KEY_TO_SLUG: Readonly<Record<string, string>>;

export const SLUG_TO_VIEW_KEY: Readonly<Record<string, string>>;
