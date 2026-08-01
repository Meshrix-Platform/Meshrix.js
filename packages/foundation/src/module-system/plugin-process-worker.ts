import { createPluginProcessRpcPeer } from "./plugin-process-rpc.ts";

if (typeof process.send !== "function") throw new Error("Plugin process worker requires an IPC channel.");

const peer: any = createPluginProcessRpcPeer({
  send: (message?: any) : any => process.send(message),
  subscribe: (receive?: any) : any => process.on("message", receive),
  onClose: (close?: any) : any => process.once("disconnect", close)
});

peer.register("module.load", async (moduleUrl?: any) : Promise<any> => {
  const loaded: any = await import(String(moduleUrl));
  return Object.fromEntries((Object.entries(loaded) as [string, any][]));
});

process.send({ type: "plugin-process.ready" });
