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
import { routeAccessPolicyAllowsSubject } from "../../../apps/console/router/route-access-policy.ts";
import {
  configureRuntimeRouteGuard,
  installRuntimeRouteGuard,
} from "../../../apps/console/router/runtime-route-guard";

const View: Record<string, any> = { template: "<div />" };

function createTestRouter() : any {
  const router: any = createRouter({
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
    const digest: any = result.artifactDigest.replace(/^sha256:/u, "");
    result.assetUrl = `/api/plugins/v1/console-assets/${result.pluginId}/${result.artifactGeneration}/${digest}/entry/asset.ts`;
  }
  return result;
}

function createModuleImporter() : any {
  return vi.fn(async () : Promise<any> => ({
    mountPluginConsole: vi.fn(() : any => () : any => {}),
  }));
}

describe("plugin console runtime routes", () : any => {
  it("registers only enabled exact plugin components and removes the active route safely", async () : Promise<any> => {
    const router: any = createTestRouter();
    const moduleImporter: any = createModuleImporter();
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
    await new Promise((resolve?: any) : any => setTimeout(resolve, 0));
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.getRoutes().some((route?: any) : any => route.path === "/admin/sample-plugin")).toBe(false);
  });

  it("resolves and registers multiple views from one plugin artifact", async () : Promise<any> => {
    const moduleImporter: any = createModuleImporter();
    const sampleEntries: any[] = [
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
      const loadComponent: any = resolvePluginConsoleComponent(sampleEntry, moduleImporter);
      expect(loadComponent).toBeTypeOf("function");
      await expect(loadComponent?.()).resolves.toMatchObject({ name: expect.stringMatching(/^PluginConsole_/u) });
    }

    const router: any = createTestRouter();
    expect(() : any => syncPluginConsoleRoutes(router, sampleEntries, { moduleImporter })).not.toThrow();
    expect(router.getRoutes().filter((route?: any) : any => route.meta.pluginId === "sample-plugin"))
      .toHaveLength(sampleEntries.length);
  });

  it("denies direct navigation before authorization and with missing scopes", async () : Promise<any> => {
    const router: any = createTestRouter();
    const moduleImporter: any = createModuleImporter();
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

  it("fails closed for missing assets and core route conflicts", () : any => {
    const router: any = createTestRouter();
    expect(() : any => syncPluginConsoleRoutes(router, [entry({
      assetUrl: "https://invalid.example/plugin.ts",
    })])).toThrow(/component is unavailable/u);
    expect(() : any => syncPluginConsoleRoutes(router, [entry({ routePath: "/" })])).toThrow(/route conflicts/u);
  });

  it("hides slot entries and avoids resolving their component before policy authorization", () : any => {
    const moduleImporter: any = createModuleImporter();
    const slotEntry: any = entry({
      id: "workspace.local-directory",
      pluginId: "sample-plugin",
      featureId: "sample-feature",
      viewKey: "workspacePanel",
      routePath: undefined,
      slotId: "workspace.local-directory",
      componentId: "sample-plugin/WorkspacePanel",
      requiredScopes: ["workspace:read"],
    });
    const check: any = (scopes: string[], features: string[]) : any => (meta?: any) : any =>
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

    const router: any = createTestRouter();
    expect(() : any => syncPluginConsoleRoutes(router, [slotEntry], { moduleImporter })).not.toThrow();
    expect(router.getRoutes().some((route?: any) : any => route.meta.pluginId === "sample-plugin")).toBe(false);
  });
});
