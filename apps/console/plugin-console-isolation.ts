export const PLUGIN_CONSOLE_BRIDGE_VERSION: any = "v0.0.1:plugin:console-bridge-1";
export const PLUGIN_CONSOLE_IFRAME_SANDBOX: any = "allow-scripts";
export const PLUGIN_CONSOLE_MOUNT_EXPORT: any = "mountPluginConsole";
export const PLUGIN_CONSOLE_SANDBOX_URL: any = "srcdoc:opaque";
export const PLUGIN_CONSOLE_MAX_ASSET_BYTES: any = 4 * 1024 * 1024;
export const PLUGIN_CONSOLE_MAX_REQUEST_BYTES: any = 1 * 1024 * 1024;
export const PLUGIN_CONSOLE_MAX_RESPONSE_BYTES: any = 8 * 1024 * 1024;
export const PLUGIN_CONSOLE_MAX_CONCURRENT_CALLS: any = 4;
export const PLUGIN_CONSOLE_CALL_TIMEOUT_MS: any = 30_000;

const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const TOOL_ID_PATTERN: any = /^[a-z][a-zA-Z0-9._-]*$/u;
const INVOKE_ID_PATTERN: any = /^[A-Za-z0-9._-]{1,128}$/u;
const MOUNT_EXPORT_PATTERN: any = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export type PluginConsoleIsolationEntry = {
  pluginId: string;
  featureId?: string;
  viewKey?: string;
  componentId: string;
  assetUrl?: string;
  assetExport?: string;
  sandboxUrl?: string;
  bridgeVersion?: string;
  artifactDigest: string;
  artifactGeneration: number;
  toolIds?: readonly string[];
  requiredScopes?: readonly string[];
};

export type PluginConsoleIsolationSurface = {
  pluginId: string;
  componentId: string;
  sandboxUrl: string;
  bridgeVersion: string;
  artifactDigest: string;
  artifactGeneration: number;
  toolIds: readonly string[];
  assetFetchUrl: string;
  mountExport: string;
  sandbox: string;
};

export type PluginConsoleHostContext = {
  locale: string;
  theme: { colorScheme: string };
  route: { path: string; viewKey: string };
};

export type PluginConsoleRevalidation =
  | { ok: true }
  | { ok: false; reason: string };

export type PluginConsoleIsolationHost = {
  loadAsset?: (url: string, options?: { signal?: AbortSignal }) => Promise<string>;
  invokeTool?: (request: {
    toolId: string;
    payload: unknown;
    signal: AbortSignal;
    entry: PluginConsoleIsolationSurface;
  }) => Promise<unknown>;
  revalidate?: () => PluginConsoleRevalidation;
  readHostContext?: () => PluginConsoleHostContext;
};

function uniqueToolIds(value?: any) : any {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) return null;
  const output: any[] = [];
  const seen: any = new Set<any>();
  for (const entry of value) {
    const id: any = String(entry || "").trim();
    if (!TOOL_ID_PATTERN.test(id) || seen.has(id)) return null;
    seen.add(id);
    output.push(id);
  }
  return Object.freeze(output);
}

export function pluginConsoleAssetFetchUrl(entry: PluginConsoleIsolationEntry) : any {
  const digest: any = String(entry.artifactDigest || "").replace(/^sha256:/u, "");
  const prefix: any = `/api/plugins/v1/console-assets/${entry.pluginId}/${entry.artifactGeneration}/${digest}/`;
  const assetUrl: any = String(entry.assetUrl || "");
  if (
    !DIGEST_PATTERN.test(String(entry.artifactDigest || "")) ||
    !Number.isSafeInteger(entry.artifactGeneration) ||
    entry.artifactGeneration < 1 ||
    !assetUrl.startsWith(prefix) ||
    !assetUrl.endsWith(".ts") ||
    /[?#]/u.test(assetUrl) ||
    assetUrl.split("/").includes("..")
  ) {
    return "";
  }
  return assetUrl;
}

export function admitPluginConsoleIsolationEntry(
  entry: PluginConsoleIsolationEntry,
): PluginConsoleIsolationSurface | undefined {
  const pluginId: any = String(entry?.pluginId || "");
  const prefix: any = `${pluginId}/`;
  if (!pluginId || !String(entry.componentId || "").startsWith(prefix)) return undefined;
  const componentName: any = String(entry.componentId).slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(componentName)) return undefined;
  const mountExport: any = String(entry.assetExport || PLUGIN_CONSOLE_MOUNT_EXPORT);
  if (!MOUNT_EXPORT_PATTERN.test(mountExport) || mountExport !== PLUGIN_CONSOLE_MOUNT_EXPORT) {
    return undefined;
  }
  const assetFetchUrl: any = pluginConsoleAssetFetchUrl(entry);
  if (!assetFetchUrl) return undefined;
  if (entry.bridgeVersion && entry.bridgeVersion !== PLUGIN_CONSOLE_BRIDGE_VERSION) return undefined;
  const sandboxUrl: any = String(entry.sandboxUrl || PLUGIN_CONSOLE_SANDBOX_URL);
  if (sandboxUrl !== PLUGIN_CONSOLE_SANDBOX_URL && sandboxUrl !== "about:srcdoc") return undefined;
  const toolIds: any = uniqueToolIds(entry.toolIds);
  if (!toolIds) return undefined;
  return {
    pluginId,
    componentId: String(entry.componentId),
    sandboxUrl: PLUGIN_CONSOLE_SANDBOX_URL,
    bridgeVersion: PLUGIN_CONSOLE_BRIDGE_VERSION,
    artifactDigest: String(entry.artifactDigest),
    artifactGeneration: entry.artifactGeneration,
    toolIds,
    assetFetchUrl,
    mountExport,
    sandbox: PLUGIN_CONSOLE_IFRAME_SANDBOX,
  };
}

export function utf8JsonByteLength(value?: any) : any {
  try {
    const encoded: any = JSON.stringify(value === undefined ? null : value);
    if (typeof encoded !== "string") return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(encoded).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createPluginConsoleSandboxDocument({
  source,
  mountExport = PLUGIN_CONSOLE_MOUNT_EXPORT,
  componentId,
  bridgeVersion = PLUGIN_CONSOLE_BRIDGE_VERSION,
}: Record<string, any> = {}) : any {
  if (typeof source !== "string" || !source || new TextEncoder().encode(source).length > PLUGIN_CONSOLE_MAX_ASSET_BYTES) {
    throw new Error("Verified plugin console module export is unavailable.");
  }
  if (!MOUNT_EXPORT_PATTERN.test(String(mountExport || "")) || String(mountExport) !== PLUGIN_CONSOLE_MOUNT_EXPORT) {
    throw new Error("Verified plugin console module export is unavailable.");
  }
  const encodedSource: any = JSON.stringify(source).replace(/</gu, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';">
</head>
<body>
<div id="meshrix-plugin-console-root"></div>
<script>
(async function () {
  const source = ${encodedSource};
  const mountExport = ${JSON.stringify(PLUGIN_CONSOLE_MOUNT_EXPORT)};
  const componentId = ${JSON.stringify(String(componentId || ""))};
  const expectedBridge = ${JSON.stringify(String(bridgeVersion || PLUGIN_CONSOLE_BRIDGE_VERSION))};
  const root = document.getElementById("meshrix-plugin-console-root");
  let port = null;
  window.addEventListener("message", async function (event) {
    if (port || !event.ports || event.ports.length !== 1) return;
    const init = event.data;
    port = event.ports[0];
    port.start();
    if (!init || init.type !== "meshrix.plugin-console.init" || init.bridgeVersion !== expectedBridge) {
      try { port.close(); } catch (error) {}
      root.textContent = "Plugin console view could not be loaded.";
      return;
    }
    try {
      const blob = new Blob([source], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const module = await import(url);
      URL.revokeObjectURL(url);
      const mount = module[mountExport];
      if (typeof mount !== "function") throw new Error("missing mount");
      await mount({
        element: root,
        componentId: componentId,
        context: init.context,
        invokeTool: function (toolId, payload) {
          return new Promise(function (resolve, reject) {
            const id = "c" + Math.random().toString(36).slice(2);
            const onMessage = function (message) {
              const data = message.data;
              if (!data || data.id !== id) return;
              port.removeEventListener("message", onMessage);
              if (data.type === "meshrix.plugin-console.result" && data.ok === true) resolve(data.result);
              else reject(new Error((data && data.error && data.error.code) || "plugin_console_tool_denied"));
            };
            port.addEventListener("message", onMessage);
            port.postMessage({ type: "meshrix.plugin-console.invoke", id: id, toolId: toolId, payload: payload });
          });
        }
      });
    } catch (error) {
      root.textContent = "Plugin console view could not be loaded.";
      try { port.postMessage({ type: "meshrix.plugin-console.failed" }); } catch (postError) {}
    }
  }, { once: true });
  window.parent.postMessage({
    type: "meshrix.plugin-console.guest-ready",
    bridgeVersion: expectedBridge
  }, "*");
})();
</script>
</body>
</html>`;
}

export function readPluginConsoleHostContext(entry: PluginConsoleIsolationSurface) : PluginConsoleHostContext {
  const html: any = globalThis.document?.documentElement;
  const colorScheme: any = String(
    html?.dataset?.appearanceColorScheme || html?.style?.colorScheme || "light"
  );
  const locale: any = String(html?.lang || "zh-CN");
  const hash: any = String(globalThis.location?.hash || "").replace(/^#/u, "");
  return {
    locale,
    theme: { colorScheme: colorScheme === "dark" ? "dark" : "light" },
    route: {
      path: hash || String(globalThis.location?.pathname || "/"),
      viewKey: String(entry.componentId || ""),
    },
  };
}

export async function loadPluginConsoleAssetBytes(
  url?: any,
  { signal, maxBytes = PLUGIN_CONSOLE_MAX_ASSET_BYTES }: Record<string, any> = {},
) : Promise<any> {
  const response: any = await fetch(String(url || ""), {
    method: "GET",
    credentials: "same-origin",
    signal,
    headers: { Accept: "text/javascript" },
  });
  if (!response?.ok) throw new Error("Verified plugin console module export is unavailable.");
  const bytes: any = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) {
    throw new Error("Verified plugin console module export is unavailable.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function connectPluginConsoleHostBridge({
  iframe,
  port,
  entry,
  context,
  invokeTool,
  revalidate,
}: Record<string, any> = {}) : any {
  let hostPort: any = port;
  let channel: any = null;
  let revoked: any = false;
  let inFlight: any = 0;
  const timers: any = new Set<any>();
  const controllers: any[] = [];

  function closePort() : any {
    try { hostPort?.close?.(); } catch {}
    hostPort = null;
  }

  function revoke(reason: any = "plugin_console_revoked") : any {
    if (revoked) return;
    revoked = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const controller of controllers) {
      try { controller.abort(String(reason || "plugin_console_revoked")); } catch {}
    }
    controllers.length = 0;
    try {
      hostPort?.postMessage?.({
        type: "meshrix.plugin-console.revoke",
        reason: String(reason || "plugin_console_revoked"),
      });
    } catch {}
    closePort();
    try { iframe?.remove?.(); } catch {}
  }

  if (!hostPort) {
    channel = new MessageChannel();
    hostPort = channel.port1;
    const target: any = iframe?.contentWindow;
    if (!target || typeof target.postMessage !== "function") {
      throw new Error("Plugin console view could not be loaded.");
    }
    target.postMessage({
      type: "meshrix.plugin-console.init",
      bridgeVersion: entry.bridgeVersion,
      context,
    }, "*", [channel.port2]);
  }
  hostPort.start?.();

  hostPort.addEventListener("message", async (event?: any) : Promise<any> => {
    const data: any = event?.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "meshrix.plugin-console.failed") {
      revoke("plugin_console_failed");
      return;
    }
    if (data.type !== "meshrix.plugin-console.invoke") return;
    const id: any = String(data.id || "");
    const toolId: any = String(data.toolId || "");
    if (!INVOKE_ID_PATTERN.test(id)) return;
    function reply(payload?: any) : any {
      if (revoked) return;
      try { hostPort.postMessage({ id, ...payload }); } catch {}
    }
    if (revoked) {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_bridge_revoked" } });
      return;
    }
    const status: any = typeof revalidate === "function" ? revalidate() : { ok: true };
    if (!status || status.ok !== true) {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_revalidation_failed" } });
      revoke(status?.reason || "plugin_console_revalidation_failed");
      return;
    }
    if (!entry.toolIds.includes(toolId) || !TOOL_ID_PATTERN.test(toolId)) {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_tool_denied" } });
      return;
    }
    if (utf8JsonByteLength(data.payload) > PLUGIN_CONSOLE_MAX_REQUEST_BYTES) {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_payload_too_large" } });
      return;
    }
    if (inFlight >= PLUGIN_CONSOLE_MAX_CONCURRENT_CALLS) {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_concurrency_limit" } });
      return;
    }
    if (typeof invokeTool !== "function") {
      reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_tool_denied" } });
      return;
    }
    inFlight += 1;
    const controller: any = new AbortController();
    controllers.push(controller);
    const timer: any = setTimeout(() : any => controller.abort("plugin_console_timeout"), PLUGIN_CONSOLE_CALL_TIMEOUT_MS);
    timers.add(timer);
    try {
      const result: any = await invokeTool({
        toolId,
        payload: data.payload,
        signal: controller.signal,
        entry,
      });
      if (utf8JsonByteLength(result) > PLUGIN_CONSOLE_MAX_RESPONSE_BYTES) {
        reply({ type: "meshrix.plugin-console.result", ok: false, error: { code: "plugin_console_payload_too_large" } });
        return;
      }
      reply({ type: "meshrix.plugin-console.result", ok: true, result });
    } catch (error: any) {
      const code: any = String(error?.code || error?.name || "plugin_console_tool_denied");
      reply({
        type: "meshrix.plugin-console.result",
        ok: false,
        error: { code: code === "AbortError" ? "plugin_console_timeout" : "plugin_console_tool_denied" },
      });
    } finally {
      clearTimeout(timer);
      timers.delete(timer);
      const index: any = controllers.indexOf(controller);
      if (index >= 0) controllers.splice(index, 1);
      inFlight = Math.max(0, inFlight - 1);
    }
  });

  return Object.freeze({
    revoke,
    get revoked() : any { return revoked; },
  });
}

export function createOpaquePluginConsoleIframe() : any {
  const iframe: any = globalThis.document.createElement("iframe");
  iframe.setAttribute("sandbox", PLUGIN_CONSOLE_IFRAME_SANDBOX);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("title", "Plugin console");
  iframe.setAttribute("data-testid", "plugin-console-isolation-frame");
  iframe.style.cssText = "border:0;width:100%;height:100%;min-height:24rem;background:transparent;flex:1;";
  return iframe;
}

export async function mountPluginConsoleIsolation(
  hostElement: Element,
  entry: PluginConsoleIsolationSurface,
  host: PluginConsoleIsolationHost = {},
) : Promise<any> {
  const controller: any = new AbortController();
  const source: any = await (host.loadAsset || loadPluginConsoleAssetBytes)(entry.assetFetchUrl, {
    signal: controller.signal,
  });
  const iframe: any = createOpaquePluginConsoleIframe();
  const srcdoc: any = createPluginConsoleSandboxDocument({
    source,
    mountExport: entry.mountExport,
    componentId: entry.componentId,
    bridgeVersion: entry.bridgeVersion,
  });
  let bridge: any = null;
  let connected: any = false;
  function connect() : any {
    if (connected || !iframe.contentWindow) return;
    connected = true;
    window.removeEventListener("message", onGuestReady);
    bridge = connectPluginConsoleHostBridge({
      iframe,
      entry,
      context: (host.readHostContext || (() : any => readPluginConsoleHostContext(entry)))(),
      invokeTool: host.invokeTool,
      revalidate: host.revalidate,
    });
  }
  function onGuestReady(event?: any) : any {
    if (event?.source !== iframe.contentWindow) return;
    if (event.data?.type !== "meshrix.plugin-console.guest-ready") return;
    if (event.data?.bridgeVersion !== entry.bridgeVersion) return;
    connect();
  }
  window.addEventListener("message", onGuestReady);
  hostElement.replaceChildren(iframe);
  iframe.srcdoc = srcdoc;
  return () : any => {
    controller.abort("plugin_console_unmounted");
    window.removeEventListener("message", onGuestReady);
    bridge?.revoke("plugin_console_unmounted");
    bridge = null;
    hostElement.replaceChildren();
  };
}
