import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import type { AdminRouteEntry } from "./routes";
import {
  ADMIN_ROUTE_REGISTRY,
  resolveAdminComponent,
} from "./routes";
import {
  routeAccessPolicyForAdminView,
  routeAccessPolicyForView,
} from "./route-access-policy.mjs";
import { installRuntimeRouteGuard } from "./runtime-route-guard";
export type { AdminSection } from "./routes";
export { adminSectionToSlug, slugToAdminView, viewToPath } from "./routes";

// ─── Error component for missing admin views ─────────────────────────────────

/**
 * Placeholder component shown when an admin view component is missing.
 * This ensures the route still exists so it can be diagnosed via the verifier
 * and the router table remains inspectable.
 */
const MissingAdminView = {
  template: '<div class="admin-error">Admin view component not found — see build logs.</div>',
};

// ─── Route Definitions ────────────────────────────────────────────────────────

const routes: RouteRecordRaw[] = [
  {
    path: "/welcome",
    component: () => import("../views/LandingView.vue"),
    meta: { public: true, accessPolicy: routeAccessPolicyForView("welcome") },
  },
  {
    path: "/login",
    component: () => import("../views/LoginView.vue"),
    meta: { authView: true, accessPolicy: routeAccessPolicyForView("login") },
  },

  {
    path: "/workspaces",
    component: () => import("../views/WorkspacesView.vue"),
    meta: { viewId: "workspaces", accessPolicy: routeAccessPolicyForView("workspaces") },
  },

  // Core views
  {
    path: "/",
    component: () => import("../views/DashboardView.vue"),
    meta: { viewId: "dashboard", accessPolicy: routeAccessPolicyForView("dashboard") },
  },
  {
    path: "/approval",
    component: () => import("../views/ApprovalFlowView.vue"),
    meta: { viewId: "approval", accessPolicy: routeAccessPolicyForView("approval") },
  },
  { path: "/intelligence", redirect: "/" },

  // ── Admin routes generated from ADMIN_ROUTE_REGISTRY ──────────────────────
  { path: "/admin", redirect: "/admin/storage" },

  // One route per registry entry — all share viewId "admin".
  // Uses resolveAdminComponent (import.meta.glob) for Vite build safety.
  // Missing components get an explicit error placeholder instead of being
  // silently dropped — the verifier catches these at build time.
  ...ADMIN_ROUTE_REGISTRY.map((entry: AdminRouteEntry) => {
    const component = resolveAdminComponent(entry.viewKey);
    return {
      path: `/admin/${entry.slug}` as const,
      component: component || MissingAdminView,
      meta: {
        viewId: "admin" as const,
        adminView: entry.viewKey,
        accessPolicy: routeAccessPolicyForAdminView(entry.viewKey),
      },
    };
  }),

  // Catch-all → dashboard
  {
    path: "/:pathMatch(.*)*",
    redirect: (to) => ({ path: "/welcome", query: { redirect: to.fullPath } }),
  },
];

export const router = createRouter({
  // Hash history works without server-side routing configuration
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

installRuntimeRouteGuard(router);
