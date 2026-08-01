import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPluginProcessRpcPeer } from "./plugin-process-rpc.ts";

const WORKER_PATH: any = fileURLToPath(new URL("./plugin-process-worker.ts", import.meta.url));

export async function createIsolatedPluginProcessHost({ startupTimeoutMs = 10_000 }: Record<string, any> = {}) : Promise<any> {
  const child: any = fork(WORKER_PATH, [], {
    env: { NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced"
  });
  const peer: any = createPluginProcessRpcPeer({
    send: (message?: any) : any => child.send(message),
    subscribe: (receive?: any) : any => child.on("message", receive),
    onClose: (close?: any) : any => child.once("exit", close)
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    const timeout: any = setTimeout(() : any => reject(Object.assign(new Error("Plugin process startup timed out."), { code: "plugin_process_startup_timeout" })), startupTimeoutMs);
    timeout.unref?.();
    const ready: any = (message?: any) : any => {
      if (message?.type !== "plugin-process.ready") return;
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("message", ready);
      resolve();
    };
    const failed: any = (error?: any) : any => {
      clearTimeout(timeout);
      child.off("message", ready);
      reject(error);
    };
    child.on("message", ready);
    child.once("error", failed);
  });

  let closed: any = false;
  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    processId: child.pid,
    loadModule({ moduleUrl }: Record<string, any>) : any {
      return peer.call("module.load", [moduleUrl]);
    },
    async close() : Promise<any> {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve?: any) : any => {
        const timeout: any = setTimeout(() : any => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        timeout.unref?.();
        child.once("exit", () : any => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  });
}
