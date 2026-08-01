import type { Router } from "vue-router";
import { routeAccessPolicyAllowsSubject } from "./route-access-policy.ts";

type GuardState = {
  ready: boolean;
  authenticated: boolean;
  scopes: string[];
  activeFeatureIds: string[];
  pendingPath: string;
};

const guardStates: any = new WeakMap<Router, GuardState>();

function stateFor(router: Router) : any {
  let state: any = guardStates.get(router);
  if (!state) {
    state = { ready: false, authenticated: false, scopes: [], activeFeatureIds: [], pendingPath: "" };
    guardStates.set(router, state);
  }
  return state;
}

function routeAllowed(route: { meta?: Record<string, unknown> }, state: GuardState) : any {
  return routeAccessPolicyAllowsSubject(
    route.meta?.accessPolicy as never,
    { scopes: state.scopes },
    state.activeFeatureIds,
  );
}

function isConcreteRoute(route: ReturnType<Router["resolve"]>) : any {
  return route.matched.length > 0 && !route.matched.some((entry?: any) : any => entry.path.includes(":pathMatch"));
}

export function installRuntimeRouteGuard(router: Router) : any {
  stateFor(router);
  router.beforeEach((to?: any) : any => {
    if (to.meta?.public === true || to.meta?.authView === true) return true;
    const state: any = stateFor(router);
    if (!state.ready) {
      state.pendingPath = to.fullPath;
      return { path: "/welcome", query: { redirect: to.fullPath } };
    }
    if (!state.authenticated) {
      state.pendingPath = to.fullPath;
      return { path: "/welcome", query: { redirect: to.fullPath } };
    }
    return routeAllowed(to, state) ? true : { path: "/" };
  });
}

export function configureRuntimeRouteGuard(router: Router, input: {
  ready: boolean;
  authenticated: boolean;
  scopes?: readonly string[];
  activeFeatureIds?: readonly string[];
}) : any {
  const state: any = stateFor(router);
  state.ready = input.ready === true;
  state.authenticated = input.authenticated === true;
  state.scopes = [...(input.scopes || [])];
  state.activeFeatureIds = [...(input.activeFeatureIds || [])];
  const redirect: any = String(router.currentRoute.value.query.redirect || "");
  const targetPath: any = state.pendingPath || redirect;
  if (!state.ready || !state.authenticated || !targetPath.startsWith("/") || targetPath.startsWith("//")) return;
  const target: any = router.resolve(targetPath);
  if (!isConcreteRoute(target) || !routeAllowed(target, state)) return;
  state.pendingPath = "";
  void router.replace(targetPath);
}
