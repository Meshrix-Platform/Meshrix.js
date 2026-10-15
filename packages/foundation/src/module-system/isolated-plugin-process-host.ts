import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPluginProcessRpcPeer } from "./plugin-process-rpc.ts";

const WORKER_PATH: any = fileURLToPath(new URL(
  `./plugin-process-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
  import.meta.url
));
const PROCESS_SHUTDOWN_GRACE_MS: any = 2_000;

export async function createIsolatedPluginProcessHost({ startupTimeoutMs }: Record<string, any> = {}) : Promise<any> {
  if (startupTimeoutMs !== undefined && (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 0)) {
    throw new RangeError("Plugin process startup timeout must be a non-negative whole number.");
  }
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
  let childClosed: any = false;
  let resolveChildClosed: any;
  const childClosedPromise: Promise<void> = new Promise((resolve?: any) : any => {
    resolveChildClosed = resolve;
  });
  child.once("close", () : any => {
    childClosed = true;
    resolveChildClosed();
  });

  let closed: any = false;
  let closePromise: Promise<void> | null = null;
  function stopChild(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () : Promise<void> => {
      if (!childClosed) {
        const escalation: any = setTimeout(() : any => {
          if (!childClosed) {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, PROCESS_SHUTDOWN_GRACE_MS);
        escalation.unref?.();
        try { child.kill("SIGTERM"); } catch {
          try { child.kill("SIGKILL"); } catch {}
        }
        await childClosedPromise;
        clearTimeout(escalation);
      }
    })();
    return closePromise;
  }

  await new Promise((resolve?: any, reject?: any) : any => {
    let settled: any = false;
    let timeout: any = null;
    const cleanup: any = () : any => {
      if (timeout) clearTimeout(timeout);
      child.off("message", ready);
      child.off("close", exitedBeforeReady);
    };
    const failAfterExit: any = (error?: any) : any => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopChild().then(() : any => reject(error), () : any => reject(error));
    };
    const ready: any = (message?: any) : any => {
      if (message?.type !== "plugin-process.ready" || settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const exitedBeforeReady: any = () : any => {
      failAfterExit(Object.assign(new Error("Plugin process exited before startup completed."), {
        code: "plugin_process_startup_failed"
      }));
    };
    child.on("message", ready);
    child.once("close", exitedBeforeReady);
    child.on("error", () : any => {
      failAfterExit(Object.assign(new Error("Plugin process could not be started."), {
        code: "plugin_process_start_failed"
      }));
    });
    if (startupTimeoutMs !== undefined) {
      timeout = setTimeout(() : any => {
        failAfterExit(Object.assign(new Error("Plugin process startup was cancelled by its caller."), {
          code: "plugin_process_startup_cancelled"
        }));
      }, startupTimeoutMs);
      timeout.unref?.();
    }
  });

  return Object.freeze({
    id: "IsolatedPluginProcessHost",
    isolation: "out-of-process",
    processId: child.pid,
    loadModule({ moduleUrl }: Record<string, any>) : any {
      if (closed) {
        return Promise.reject(Object.assign(new Error("Plugin process host is closed."), {
          code: "plugin_process_host_closed"
        }));
      }
      return peer.call("module.load", [moduleUrl]);
    },
    close() : Promise<void> {
      return stopChild();
    }
  });
}
