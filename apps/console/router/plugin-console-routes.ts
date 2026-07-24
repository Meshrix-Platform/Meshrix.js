import type { Router, RouteRecordRaw } from "vue-router";
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";

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
  artifactDigest: string;
  artifactGeneration: number;
  label?: string;
  requiredScopes: readonly string[];
};

export type RoutedPluginConsoleEntry = PluginConsoleEntry & { routePath: string };
export type PluginConsoleModuleImporter = (assetUrl: string) => Promise<Record<string, unknown>>;

const importPluginConsoleModule: PluginConsoleModuleImporter = (assetUrl) =>
  import(/* @vite-ignore */ assetUrl);

export function hasPluginConsoleRoute(entry: PluginConsoleEntry): entry is RoutedPluginConsoleEntry {
  return typeof entry.routePath === "string" && entry.routePath.length > 0;
}

export function isAdminPluginConsoleEntry(entry: PluginConsoleEntry) {
  return hasPluginConsoleRoute(entry) && entry.routePath.startsWith("/admin/");
}

export function pluginConsoleEntryAccessMeta(entry: PluginConsoleEntry) {
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
) {
  return canAccessRouteMeta(pluginConsoleEntryAccessMeta(entry));
}

const routeRegistrations = new WeakMap<Router, Map<string, () => void>>();

function validConsoleAssetUrl(entry: PluginConsoleEntry) {
  const digest = String(entry.artifactDigest || "").replace(/^sha256:/u, "");
  const prefix = `/api/plugins/v1/console-assets/${entry.pluginId}/${entry.artifactGeneration}/${digest}/`;
  return /^sha256:[a-f0-9]{64}$/u.test(entry.artifactDigest) &&
    Number.isSafeInteger(entry.artifactGeneration) && entry.artifactGeneration > 0 &&
    entry.assetUrl.startsWith(prefix) && entry.assetUrl.endsWith(".mjs") &&
    !/[?#]/u.test(entry.assetUrl) && !entry.assetUrl.split("/").includes("..");
}

function pluginConsoleComponentLoader(
  entry: PluginConsoleEntry,
  moduleImporter: PluginConsoleModuleImporter,
) {
  return async () => {
    const pluginModule = await moduleImporter(entry.assetUrl);
    const mountPluginConsole = pluginModule?.[entry.assetExport];
    if (typeof mountPluginConsole !== "function") {
      throw new Error("Verified plugin console module export is unavailable.");
    }
    return defineComponent({
      name: `PluginConsole_${entry.pluginId}_${entry.viewKey}`,
      setup() {
        const mountElement = ref<Element | null>(null);
        const failure = ref("");
        const controller = new AbortController();
        let dispose: null | (() => unknown) = null;
        onMounted(async () => {
          try {
            const result = await mountPluginConsole({
              element: mountElement.value,
              componentId: entry.componentId,
              signal: controller.signal,
            });
            dispose = typeof result === "function" ? result : null;
          } catch {
            failure.value = "Plugin console view could not be loaded.";
          }
        });
        onBeforeUnmount(() => {
          controller.abort("plugin_console_unmounted");
          if (dispose) void Promise.resolve(dispose()).catch(() => {});
          dispose = null;
        });
        return () => h("div", {
          class: "meshrix-plugin-console-host",
          ref: mountElement,
        }, failure.value || undefined);
      },
    });
  };
}

export function resolvePluginConsoleComponent(
  entry: PluginConsoleEntry,
  moduleImporter: PluginConsoleModuleImporter = importPluginConsoleModule,
): (() => Promise<any>) | undefined {
  const prefix = `${entry.pluginId}/`;
  if (!entry.componentId.startsWith(prefix)) return undefined;
  const componentName = entry.componentId.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(componentName)) return undefined;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(entry.assetExport) || !validConsoleAssetUrl(entry)) return undefined;
  return pluginConsoleComponentLoader(entry, moduleImporter);
}

export function resolveAccessiblePluginConsoleComponent(
  entry: PluginConsoleEntry,
  canAccessRouteMeta: (meta: unknown) => boolean,
  moduleImporter: PluginConsoleModuleImporter = importPluginConsoleModule,
) {
  if (!canAccessPluginConsoleEntry(entry, canAccessRouteMeta)) return undefined;
  return resolvePluginConsoleComponent(entry, moduleImporter);
}

function routeName(entry: PluginConsoleEntry) {
  return `plugin-console:${entry.pluginId}:${entry.id}`;
}

export function syncPluginConsoleRoutes(
  router: Router,
  entries: readonly PluginConsoleEntry[] = [],
  { moduleImporter = importPluginConsoleModule }: { moduleImporter?: PluginConsoleModuleImporter } = {},
) {
  for (const entry of entries) {
    if (!resolvePluginConsoleComponent(entry, moduleImporter)) {
      throw new Error(`Enabled plugin console component is unavailable: ${entry.componentId}.`);
    }
  }
  const routeEntries = entries.filter(hasPluginConsoleRoute);
  const desiredNames = new Set(routeEntries.map(routeName));
  const registrations = routeRegistrations.get(router) || new Map<string, () => void>();
  routeRegistrations.set(router, registrations);
  for (const [name, dispose] of registrations) {
    if (!desiredNames.has(name)) {
      const registeredRoute = router.getRoutes().find((route) => route.name === name);
      const wasActive = router.currentRoute.value.name === name || (
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
    const name = routeName(entry);
    if (registrations.has(name)) continue;
    const component = resolvePluginConsoleComponent(entry, moduleImporter);
    if (!component) continue;
    const conflict = router.getRoutes().find((candidate) => candidate.path === entry.routePath);
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
