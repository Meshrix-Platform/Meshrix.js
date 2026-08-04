import { onMounted, ref, watch, type Ref } from "vue";
import {
  useRoute,
  useRouter,
  type LocationQuery,
  type LocationQueryValue,
  type RouteLocationNormalizedLoaded,
  type Router,
} from "vue-router";

// Serializes query merges across all instances of this composable. Several
// keys can change in the same flush (LogsView writes up to seven); vue-router
// resolves one navigation at a time, and each queued task re-reads the latest
// route.query before merging, so sibling writes never clobber each other.
//
// An idle queue runs the merge immediately (synchronously in the watch flush):
// vue-router cancels the older pending navigation when two race, so the query
// replace must start BEFORE any explicit path navigation (openAdmin fallback,
// tab RouterLink) issued right after the state change — that way the path
// navigation wins and the replace is dropped instead of the other way round.
let queryMergeInFlight = false;
const queuedQueryMerges: Array<() => void> = [];

function runQueryMerge(
  route: RouteLocationNormalizedLoaded,
  router: Router,
  merge: (query: LocationQuery) => LocationQuery | null,
): void {
  if (queryMergeInFlight) {
    queuedQueryMerges.push((): void => runQueryMerge(route, router, merge));
    return;
  }
  queryMergeInFlight = true;
  const merged: LocationQuery | null = merge({ ...route.query });
  const navigation: unknown = merged ? router.replace({ query: merged }) : undefined;
  Promise.resolve(navigation)
    .catch((): void => undefined)
    .then((): void => {
      queryMergeInFlight = false;
      const nextMerge: (() => void) | undefined = queuedQueryMerges.shift();
      if (nextMerge) {
        nextMerge();
      }
    });
}

/**
 * Mirrors a string ref into `route.query[key]` so console state (tabs, filters,
 * pagination, list selection) becomes URL-addressable.
 *
 * Contract (frozen for downstream consumers):
 * - The router is the state owner; the ref is a projection of the query.
 * - On mount the ref reads `route.query[key]` (first value when the key is
 *   repeated), falling back to `defaultValue`.
 * - Ref changes write through `router.replace` only — never `push`, so filter
 *   churn adds no history entries, and never `location.hash` (the router uses
 *   hash history, so the query lives after `#`).
 * - A value equal to `defaultValue` removes the key: defaults stay out of the
 *   URL and empty stays empty.
 * - Foreign query keys are preserved untouched; external query changes
 *   (back/forward navigation, other instances) update the ref.
 *
 * Requires an active vue-router: call from a setup scope under an installed
 * router. In a non-routed render/test context the route/router injections
 * resolve to `undefined` and this composable throws instead of silently
 * no-oping — tests must provide a real router.
 */
export function useConsoleUrlState(key: string, defaultValue: string): Ref<string> {
  const injectedRoute: RouteLocationNormalizedLoaded | undefined = useRoute();
  const injectedRouter: Router | undefined = useRouter();
  if (!injectedRoute || !injectedRouter) {
    throw new Error(
      "useConsoleUrlState requires an active vue-router (route/router injection is missing).",
    );
  }
  const route: RouteLocationNormalizedLoaded = injectedRoute;
  const router: Router = injectedRouter;

  const value: Ref<string> = ref(defaultValue);

  function queryText(raw: LocationQueryValue | LocationQueryValue[] | undefined): string {
    const first: LocationQueryValue | undefined = Array.isArray(raw) ? raw[0] : raw;
    return first == null ? "" : String(first);
  }

  function readFromQuery(): string {
    const text: string = queryText(route.query[key]);
    return text === "" ? defaultValue : text;
  }

  // Mount read: project the current query into the ref.
  onMounted((): void => {
    value.value = readFromQuery();
  });

  // Ref -> URL: merge into the live query, elide the default, and skip the
  // navigation when the key is already in sync (replace-loop guard). The merge
  // runs through the shared serializer so it always applies to the latest
  // query, and it is dropped when the ref has moved past the enqueued value —
  // a stale merge would otherwise chase the newer state and ping-pong with
  // the URL -> ref projection below.
  watch(value, (next: string): void => {
    runQueryMerge(route, router, (query: LocationQuery): LocationQuery | null => {
      if (value.value !== next) {
        return null;
      }
      if (next === defaultValue) {
        if (!(key in query)) {
          return null;
        }
        delete query[key];
      } else {
        if (!Array.isArray(query[key]) && queryText(query[key]) === next) {
          return null;
        }
        query[key] = next;
      }
      return query;
    });
  });

  // URL -> ref: back/forward navigation and other instances writing the same
  // key project back into the ref.
  watch(
    (): LocationQueryValue | LocationQueryValue[] | undefined => route.query[key],
    (): void => {
      const projected: string = readFromQuery();
      if (projected !== value.value) {
        value.value = projected;
      }
    },
  );

  return value;
}
