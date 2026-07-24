import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";

import {
  canAccessPluginConsoleEntry,
  hasPluginConsoleRoute,
  isAdminPluginConsoleEntry,
  resolveAccessiblePluginConsoleComponent,
  resolvePluginConsoleComponent,
  syncPluginConsoleRoutes,
  type PluginConsoleEntry,
} from "../../../apps/console/router/plugin-console-routes";
import { routeAccessPolicyAllowsSubject } from "../../../apps/console/router/route-access-policy.mjs";
import {
  configureRuntimeRouteGuard,
  installRuntimeRouteGuard,
} from "../../../apps/console/router/runtime-route-guard";

const View = { template: "<div />" };

function createTestRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: View, meta: { accessPolicy: { routePath: "/", requiredScopes: [], requiredFeatureIds: [] } } },
      { path: "/welcome", component: View, meta: { public: true } },
      { path: "/:pathMatch(.*)*", component: View },
    ],
  });
  installRuntimeRouteGuard(router);
  return router;
}

function entry(patch: Partial<PluginConsoleEntry> = {}): PluginConsoleEntry {
  const result: PluginConsoleEntry = {
    id: "admin.sample-plugin",
    pluginId: "sample-plugin",
    featureId: "sample-feature",
    viewKey: "sampleView",
    routePath: "/admin/sample-plugin",
    componentId: "sample-plugin/AdminView",
    assetUrl: "",
    assetExport: "mountPluginConsole",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    artifactGeneration: 1,
    label: "Sample plugin",
    requiredScopes: ["console:read"],
    ...patch,
  };
  if (!result.assetUrl) {
    const digest = result.artifactDigest.replace(/^sha256:/u, "");
    result.assetUrl = `/api/plugins/v1/console-assets/${result.pluginId}/${result.artifactGeneration}/${digest}/entry/asset.mjs`;
  }
  return result;
}

function createModuleImporter() {
  return vi.fn(async () => ({
    mountPluginConsole: vi.fn(() => () => {}),
  }));
}

describe("plugin console runtime routes", () => {
  it("registers only enabled exact plugin components and removes the active route safely", async () => {
    const router = createTestRouter();
    const moduleImporter = createModuleImporter();
    syncPluginConsoleRoutes(router, [entry()], { moduleImporter });
    configureRuntimeRouteGuard(router, {
      ready: true,
      authenticated: true,
      scopes: ["console:read"],
      activeFeatureIds: ["sample-feature"],
    });
    await router.push("/admin/sample-plugin");
    expect(router.currentRoute.value.path).toBe("/admin/sample-plugin");
    expect(router.currentRoute.value.meta.pluginId).toBe("sample-plugin");
    expect(router.currentRoute.value.meta.title).toBe("Sample plugin");

    syncPluginConsoleRoutes(router, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.getRoutes().some((route) => route.path === "/admin/sample-plugin")).toBe(false);
  });

  it("resolves and registers multiple views from one plugin artifact", async () => {
    const moduleImporter = createModuleImporter();
    const sampleEntries = [
      entry({
        id: "admin.sample-a",
        featureId: "sample-feature-a",
        viewKey: "sampleA",
        routePath: "/admin/sample-a",
        componentId: "sample-plugin/SampleAView",
      }),
      entry({
        id: "admin.sample-b",
        featureId: "sample-feature-b",
        viewKey: "sampleB",
        routePath: "/admin/sample-b",
        componentId: "sample-plugin/SampleBView",
      }),
      entry({
        id: "admin.sample-c",
        featureId: "sample-feature-c",
        viewKey: "sampleC",
        routePath: "/admin/sample-c",
        componentId: "sample-plugin/SampleCView",
      }),
    ];

    for (const sampleEntry of sampleEntries) {
      const loadComponent = resolvePluginConsoleComponent(sampleEntry, moduleImporter);
      expect(loadComponent).toBeTypeOf("function");
      await expect(loadComponent?.()).resolves.toMatchObject({ name: expect.stringMatching(/^PluginConsole_/u) });
    }

    const router = createTestRouter();
    expect(() => syncPluginConsoleRoutes(router, sampleEntries, { moduleImporter })).not.toThrow();
    expect(router.getRoutes().filter((route) => route.meta.pluginId === "sample-plugin"))
      .toHaveLength(sampleEntries.length);
  });

  it("denies direct navigation before authorization and with missing scopes", async () => {
    const router = createTestRouter();
    const moduleImporter = createModuleImporter();
    syncPluginConsoleRoutes(router, [entry()], { moduleImporter });
    await router.push("/admin/sample-plugin");
    expect(router.currentRoute.value.path).toBe("/welcome");
    expect(moduleImporter).not.toHaveBeenCalled();

    configureRuntimeRouteGuard(router, {
      ready: true,
      authenticated: true,
      scopes: [],
      activeFeatureIds: ["sample-feature"],
    });
    await router.push("/admin/sample-plugin");
    expect(router.currentRoute.value.path).toBe("/");
    expect(moduleImporter).not.toHaveBeenCalled();
  });

  it("fails closed for missing assets and core route conflicts", () => {
    const router = createTestRouter();
    expect(() => syncPluginConsoleRoutes(router, [entry({
      assetUrl: "https://invalid.example/plugin.mjs",
    })])).toThrow(/component is unavailable/u);
    expect(() => syncPluginConsoleRoutes(router, [entry({ routePath: "/" })])).toThrow(/route conflicts/u);
  });

  it("hides slot entries and avoids resolving their component before policy authorization", () => {
    const moduleImporter = createModuleImporter();
    const slotEntry = entry({
      id: "workspace.local-directory",
      pluginId: "sample-plugin",
      featureId: "sample-feature",
      viewKey: "workspacePanel",
      routePath: undefined,
      slotId: "workspace.local-directory",
      componentId: "sample-plugin/WorkspacePanel",
      requiredScopes: ["workspace:read"],
    });
    const check = (scopes: string[], features: string[]) => (meta: any) =>
      routeAccessPolicyAllowsSubject(meta.accessPolicy, { scopes }, features);

    expect(canAccessPluginConsoleEntry(slotEntry, check([], ["sample-feature"]))).toBe(false);
    expect(canAccessPluginConsoleEntry(slotEntry, check(["workspace:read"], []))).toBe(false);
    expect(resolveAccessiblePluginConsoleComponent(
      slotEntry,
      check([], ["sample-feature"]),
      moduleImporter,
    )).toBeUndefined();
    expect(resolveAccessiblePluginConsoleComponent(
      slotEntry,
      check(["workspace:read"], []),
      moduleImporter,
    )).toBeUndefined();
    expect(canAccessPluginConsoleEntry(slotEntry, check(["workspace:read"], ["sample-feature"]))).toBe(true);
    expect(resolveAccessiblePluginConsoleComponent(
      slotEntry,
      check(["workspace:read"], ["sample-feature"]),
      moduleImporter,
    )).toBeTypeOf("function");
    expect(moduleImporter).not.toHaveBeenCalled();
    expect(hasPluginConsoleRoute(slotEntry)).toBe(false);
    expect(isAdminPluginConsoleEntry(slotEntry)).toBe(false);

    const router = createTestRouter();
    expect(() => syncPluginConsoleRoutes(router, [slotEntry], { moduleImporter })).not.toThrow();
    expect(router.getRoutes().some((route) => route.meta.pluginId === "sample-plugin")).toBe(false);
  });
});
