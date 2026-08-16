import type { Router, RouteRecordRaw } from "vue-router";
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";

import {
  admitPluginConsoleIsolationEntry,
  mountPluginConsoleIsolation,
  type PluginConsoleIsolationHost,
} from "../plugin-console-isolation.ts";

export type PluginConsoleEntry = {
  id: string;
  pluginId: string;
  featureId: string;
  viewKey: string;
  routePath?: string;
  slotId?: string;
  componentId: string;
  assetUrl: string;
  assetExport: string;
  sandboxUrl?: string;
  bridgeVersion?: string;
  artifactDigest: string;
  artifactGeneration: number;
  label?: string;
  requiredScopes: readonly string[];
  toolIds?: readonly string[];
};

export type RoutedPluginConsoleEntry = PluginConsoleEntry & { routePath: string };

export function hasPluginConsoleRoute(entry: PluginConsoleEntry): entry is RoutedPluginConsoleEntry {
  return typeof entry.routePath === "string" && entry.routePath.length > 0;
}

export function isAdminPluginConsoleEntry(entry: PluginConsoleEntry) : any {
  return hasPluginConsoleRoute(entry) && entry.routePath.startsWith("/admin/");
}

export function pluginConsoleEntryAccessMeta(entry: PluginConsoleEntry) : any {
  return {
    accessPolicy: {
      routePath: entry.routePath || `slot:${entry.slotId || entry.id}`,
      requiredScopes: [...entry.requiredScopes],
      requiredFeatureIds: [entry.featureId],
    },
  };
}

export function canAccessPluginConsoleEntry(
  entry: PluginConsoleEntry,
  canAccessRouteMeta: (meta: unknown) => boolean,
) : any {
  return canAccessRouteMeta(pluginConsoleEntryAccessMeta(entry));
}

const routeRegistrations: any = new WeakMap<Router, Map<string, () => void>>();

function pluginConsoleComponentLoader(
  entry: PluginConsoleEntry,
  host: PluginConsoleIsolationHost,
) : any {
  const isolation: any = admitPluginConsoleIsolationEntry(entry);
  return async () : Promise<any> => defineComponent({
    name: `PluginConsole_${entry.pluginId}_${entry.viewKey}`,
    setup() : any {
      const mountElement: any = ref<Element | null>(null);
      const failure: any = ref("");
      let dispose: null | (() => unknown) = null;
      onMounted(async () : Promise<any> => {
        try {
          if (!isolation || !mountElement.value) {
            throw new Error("Verified plugin console module export is unavailable.");
          }
          dispose = await mountPluginConsoleIsolation(mountElement.value, isolation, host);
        } catch {
          failure.value = "Plugin console view could not be loaded.";
        }
      });
      onBeforeUnmount(() : any => {
        if (dispose) void Promise.resolve(dispose()).catch(() : any => {});
        dispose = null;
      });
      return () : any => h("div", {
        class: "meshrix-plugin-console-host",
        ref: mountElement,
      }, failure.value || undefined);
    },
  });
}

export function resolvePluginConsoleComponent(
  entry: PluginConsoleEntry,
  host: PluginConsoleIsolationHost = {},
): (() => Promise<any>) | undefined {
  if (!admitPluginConsoleIsolationEntry(entry)) return undefined;
  return pluginConsoleComponentLoader(entry, host);
}

export function resolveAccessiblePluginConsoleComponent(
  entry: PluginConsoleEntry,
  canAccessRouteMeta: (meta: unknown) => boolean,
  host: PluginConsoleIsolationHost = {},
) : any {
  if (!canAccessPluginConsoleEntry(entry, canAccessRouteMeta)) return undefined;
  return resolvePluginConsoleComponent(entry, host);
}

function routeName(entry: PluginConsoleEntry) : any {
  return `plugin-console:${entry.pluginId}:${entry.id}`;
}

export function syncPluginConsoleRoutes(
  router: Router,
  entries: readonly PluginConsoleEntry[] = [],
  { host = {} }: { host?: PluginConsoleIsolationHost } = {},
) : any {
  for (const entry of entries) {
    if (!resolvePluginConsoleComponent(entry, host)) {
      throw new Error(`Enabled plugin console component is unavailable: ${entry.componentId}.`);
    }
  }
  const routeEntries: any = entries.filter(hasPluginConsoleRoute);
  const desiredNames: any = new Set<any>(routeEntries.map(routeName));
  const registrations: any = routeRegistrations.get(router) || new Map<string, () => void>();
  routeRegistrations.set(router, registrations);
  for (const [name, dispose] of registrations) {
    if (!desiredNames.has(name)) {
      const registeredRoute: any = router.getRoutes().find((route?: any) : any => route.name === name);
      const wasActive: any = router.currentRoute.value.name === name || (
        Boolean(registeredRoute) &&
        router.currentRoute.value.path === registeredRoute?.path &&
        Boolean(router.currentRoute.value.meta.pluginId)
      );
      dispose();
      registrations.delete(name);
      if (wasActive) void router.replace("/");
    }
  }

  for (const entry of routeEntries) {
    const name: any = routeName(entry);
    if (registrations.has(name)) continue;
    const component: any = resolvePluginConsoleComponent(entry, host);
    if (!component) continue;
    const conflict: any = router.getRoutes().find((candidate?: any) : any => candidate.path === entry.routePath);
    if (conflict) throw new Error(`Enabled plugin console route conflicts with ${entry.routePath}.`);
    const route: RouteRecordRaw = {
      name,
      path: entry.routePath,
      component,
      meta: {
        viewId: entry.routePath.startsWith("/admin/") ? "admin" : entry.viewKey,
        ...(entry.routePath.startsWith("/admin/") ? { adminView: entry.viewKey } : {}),
        pluginId: entry.pluginId,
        title: entry.label || entry.id,
        ...pluginConsoleEntryAccessMeta(entry),
      },
    };
    registrations.set(name, router.addRoute(route));
  }
}
