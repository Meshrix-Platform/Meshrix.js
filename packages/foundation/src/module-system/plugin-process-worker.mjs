import { createPluginProcessRpcPeer } from "./plugin-process-rpc.mjs";

if (typeof process.send !== "function") throw new Error("Plugin process worker requires an IPC channel.");

const peer = createPluginProcessRpcPeer({
  send: (message) => process.send(message),
  subscribe: (receive) => process.on("message", receive),
  onClose: (close) => process.once("disconnect", close)
});

peer.register("module.load", async (moduleUrl) => {
  const loaded = await import(String(moduleUrl));
  return Object.fromEntries(Object.entries(loaded));
});

process.send({ type: "plugin-process.ready" });
