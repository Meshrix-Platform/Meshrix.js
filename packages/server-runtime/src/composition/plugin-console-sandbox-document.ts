import {
  PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
  PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES,
  PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT
} from "#meshrix/foundation/module-system/plugin-console-isolation";

function scriptLiteral(value?: any) : any {
  return JSON.stringify(String(value || "")).replace(/</gu, "\\u003c");
}

export function pluginConsoleSandboxContentSecurityPolicy(nonce?: any) : any {
  const value: any = String(nonce || "").trim();
  if (!/^[A-Za-z0-9+/=]{16,128}$/u.test(value)) {
    throw new TypeError("Plugin console sandbox nonce is invalid.");
  }
  return [
    "default-src 'none'",
    `script-src 'nonce-${value}' blob:`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'self'"
  ].join("; ");
}

export function createPluginConsoleSandboxDocument({
  source,
  componentId,
  nonce,
  bridgeVersion = PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION
}: Record<string, any> = {}) : any {
  const bytes: any = Buffer.byteLength(String(source || ""), "utf8");
  if (typeof source !== "string" || bytes <= 0 || bytes > PLUGIN_CONSOLE_ISOLATION_MAX_ASSET_BYTES) {
    throw new Error("Verified plugin console module export is unavailable.");
  }
  const csp: any = pluginConsoleSandboxContentSecurityPolicy(nonce);
  const encodedSource: any = JSON.stringify(source).replace(/</gu, "\\u003c");
  const html: any = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
</head>
<body>
<div id="meshrix-plugin-console-root"></div>
<script nonce="${String(nonce)}">
(function () {
  const source = ${encodedSource};
  const componentId = ${scriptLiteral(componentId)};
  const expectedBridge = ${scriptLiteral(bridgeVersion)};
  const mountExport = ${scriptLiteral(PLUGIN_CONSOLE_ISOLATION_MOUNT_EXPORT)};
  const root = document.getElementById("meshrix-plugin-console-root");
  const lifecycle = new AbortController();
  const pending = new Map();
  let port = null;
  let dispose = null;
  let nextCallId = 0;

  function failPending(code) {
    for (const operation of pending.values()) operation.reject(new Error(code));
    pending.clear();
  }

  async function revoke(reason) {
    lifecycle.abort(reason || "plugin_console_revoked");
    failPending("plugin_console_bridge_revoked");
    try { await dispose?.(); } catch (error) {}
    dispose = null;
    try { port?.close(); } catch (error) {}
    port = null;
  }

  function invokeTool(toolId, payload) {
    if (!port || lifecycle.signal.aborted) {
      return Promise.reject(new Error("plugin_console_bridge_revoked"));
    }
    const id = "call-" + (++nextCallId);
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      port.postMessage({
        type: "meshrix.plugin-console.invoke",
        id: id,
        toolId: String(toolId || ""),
        payload: payload
      });
    });
  }

  window.addEventListener("message", async function (event) {
    if (event.source !== window.parent || port || !event.ports || event.ports.length !== 1) return;
    const init = event.data;
    port = event.ports[0];
    port.start();
    if (!init || init.type !== "meshrix.plugin-console.init" || init.bridgeVersion !== expectedBridge) {
      await revoke("plugin_console_bridge_version_mismatch");
      root.textContent = "Plugin console view could not be loaded.";
      return;
    }
    port.addEventListener("message", function (message) {
      const data = message.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "meshrix.plugin-console.revoke") {
        void revoke(String(data.reason || "plugin_console_revoked"));
        return;
      }
      if (data.type !== "meshrix.plugin-console.result") return;
      const operation = pending.get(String(data.id || ""));
      if (!operation) return;
      pending.delete(String(data.id || ""));
      if (data.ok === true) operation.resolve(data.result);
      else operation.reject(new Error(String(data.error?.code || "plugin_console_tool_denied")));
    });
    try {
      const blob = new Blob([source], { type: "text/javascript" });
      const moduleUrl = URL.createObjectURL(blob);
      let module;
      try { module = await import(moduleUrl); }
      finally { URL.revokeObjectURL(moduleUrl); }
      const mount = module[mountExport];
      if (typeof mount !== "function") throw new Error("missing mount");
      dispose = await mount({
        element: root,
        componentId: componentId,
        context: init.context,
        invokeTool: invokeTool,
        signal: lifecycle.signal
      });
    } catch (error) {
      root.textContent = "Plugin console view could not be loaded.";
      try { port?.postMessage({ type: "meshrix.plugin-console.failed" }); } catch (postError) {}
      await revoke("plugin_console_failed");
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
  return Object.freeze({ html, csp });
}
