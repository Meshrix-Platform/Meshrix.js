import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPluginProcessRpcPeer } from "./plugin-process-rpc.mjs";

const WORKER_PATH = fileURLToPath(new URL("./plugin-process-worker.mjs", import.meta.url));

export async function createIsolatedPluginProcessHost({ startupTimeoutMs = 10_000 } = {}) {
  const child = fork(WORKER_PATH, [], {
    env: { NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced"
  });
  const peer = createPluginProcessRpcPeer({
    send: (message) => child.send(message),
    subscribe: (receive) => child.on("message", receive),
    onClose: (close) => child.once("exit", close)
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Object.assign(new Error("Plugin process startup timed out."), { code: "plugin_process_startup_timeout" })), startupTimeoutMs);
    timeout.unref?.();
    const ready = (message) => {
      if (message?.type !== "plugin-process.ready") return;
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("message", ready);
      resolve();
    };
    const failed = (error) => {
      clearTimeout(timeout);
      child.off("message", ready);
      reject(error);
    };
    child.on("message", ready);
    child.once("error", failed);
  });

  let closed = false;
  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    processId: child.pid,
    loadModule({ moduleUrl }) {
      return peer.call("module.load", [moduleUrl]);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        timeout.unref?.();
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  });
}
