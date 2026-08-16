// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PLUGIN_CONSOLE_BRIDGE_VERSION,
  PLUGIN_CONSOLE_IFRAME_SANDBOX,
  PLUGIN_CONSOLE_MAX_CONCURRENT_CALLS,
  PLUGIN_CONSOLE_SANDBOX_URL,
  admitPluginConsoleIsolationEntry,
  connectPluginConsoleHostBridge,
  createPluginConsoleSandboxDocument,
} from "../../../apps/console/plugin-console-isolation.ts";
import { resolvePluginConsoleComponent } from "../../../apps/console/router/plugin-console-routes.ts";

const mounted: VueWrapper[] = [];

afterEach(() : any => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

function entry(patch: Record<string, any> = {}) : any {
  const artifactDigest: any = `sha256:${"a".repeat(64)}`;
  return {
    id: "admin.sample-plugin",
    pluginId: "sample-plugin",
    featureId: "sample-feature",
    viewKey: "sampleView",
    routePath: "/admin/sample-plugin",
    componentId: "sample-plugin/AdminView",
    assetUrl: `/api/plugins/v1/console-assets/sample-plugin/1/${"a".repeat(64)}/entry/asset.ts`,
    assetExport: "mountPluginConsole",
    artifactDigest,
    artifactGeneration: 1,
    requiredScopes: ["console:read"],
    toolIds: ["sample-plugin.inspect"],
    ...patch,
  };
}

describe("plugin console isolation", () : any => {
  it("admits only the opaque isolation contract", () : any => {
    const surface: any = admitPluginConsoleIsolationEntry(entry());
    expect(surface).toMatchObject({
      sandboxUrl: PLUGIN_CONSOLE_SANDBOX_URL,
      bridgeVersion: PLUGIN_CONSOLE_BRIDGE_VERSION,
      sandbox: PLUGIN_CONSOLE_IFRAME_SANDBOX,
      mountExport: "mountPluginConsole",
      toolIds: ["sample-plugin.inspect"],
    });
    expect(surface.assetFetchUrl).toContain("/api/plugins/v1/console-assets/");
    expect(admitPluginConsoleIsolationEntry(entry({ assetExport: "mountOther" }))).toBeUndefined();
    expect(admitPluginConsoleIsolationEntry(entry({ sandboxUrl: surface.assetFetchUrl }))).toBeUndefined();
  });

  it("embeds plugin source in an opaque srcdoc and never imports a Console URL", () : any => {
    const source: any = "export function mountPluginConsole({ element }) { element.textContent = 'ok'; }";
    const documentHtml: any = createPluginConsoleSandboxDocument({
      source,
      componentId: "sample-plugin/AdminView",
    });
    expect(documentHtml).toContain("connect-src 'none'");
    expect(documentHtml).toContain("meshrix.plugin-console.init");
    expect(documentHtml).toContain("createObjectURL");
    expect(documentHtml).not.toContain("/api/plugins/v1/console-assets/");
    expect(documentHtml).not.toContain("@vite-ignore");
    expect(documentHtml).not.toMatch(/import\(\s*assetUrl/u);
  });

  it("mounts an allow-scripts iframe without same-origin privileges", async () : Promise<any> => {
    const loadAsset: any = vi.fn(async () : Promise<any> => (
      "export function mountPluginConsole({ element }) { element.textContent = 'plugin'; }"
    ));
    const loader: any = resolvePluginConsoleComponent(entry(), { loadAsset });
    const component: any = await loader();
    const wrapper: any = mount(component, { attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    const iframe: any = wrapper.get("[data-testid='plugin-console-isolation-frame']");
    expect(iframe.attributes("sandbox")).toBe(PLUGIN_CONSOLE_IFRAME_SANDBOX);
    expect(iframe.attributes("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.attributes("referrerpolicy")).toBe("no-referrer");
    expect(String(iframe.element.srcdoc || "")).toContain("connect-src 'none'");
    expect(loadAsset).toHaveBeenCalledTimes(1);
    expect(loadAsset.mock.calls[0][0]).toContain("/api/plugins/v1/console-assets/sample-plugin/");
  });

  it("bounds and revokes the MessageChannel bridge", async () : Promise<any> => {
    const { port1, port2 } = new MessageChannel();
    let release: any = null;
    const gate: any = new Promise((resolve?: any) : any => {
      release = resolve;
    });
    const invokeTool: any = vi.fn(async ({ toolId }: Record<string, any>) : Promise<any> => {
      await gate;
      return { toolId };
    });
    const surface: any = admitPluginConsoleIsolationEntry(entry());
    const bridge: any = connectPluginConsoleHostBridge({
      port: port1,
      entry: surface,
      context: { locale: "en", theme: { colorScheme: "light" }, route: { path: "/admin/sample-plugin", viewKey: "sampleView" } },
      invokeTool,
      revalidate: () : any => ({ ok: true }),
    });
    const replies: any[] = [];
    port2.addEventListener("message", (event?: any) : any => replies.push(event.data));
    port2.start();

    port2.postMessage({
      type: "meshrix.plugin-console.invoke",
      id: "call-foreign",
      toolId: "other-plugin.secret",
      payload: {},
    });
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
    expect(invokeTool).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      type: "meshrix.plugin-console.result",
      ok: false,
      error: { code: "plugin_console_tool_denied" },
    });

    for (let index = 0; index < PLUGIN_CONSOLE_MAX_CONCURRENT_CALLS + 1; index += 1) {
      port2.postMessage({
        type: "meshrix.plugin-console.invoke",
        id: `call-${index}`,
        toolId: "sample-plugin.inspect",
        payload: { index },
      });
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
    expect(replies.some((reply?: any) : any => reply.error?.code === "plugin_console_concurrency_limit")).toBe(true);
    release();
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));

    bridge.revoke("plugin_console_unmounted");
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
    expect(replies.some((reply?: any) : any => reply.type === "meshrix.plugin-console.revoke")).toBe(true);
    port2.postMessage({
      type: "meshrix.plugin-console.invoke",
      id: "call-after-revoke",
      toolId: "sample-plugin.inspect",
      payload: {},
    });
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
    expect(replies.some((reply?: any) : any => reply.id === "call-after-revoke")).toBe(false);
    port1.close();
    port2.close();
  });
});
