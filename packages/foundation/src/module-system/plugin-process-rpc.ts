import { randomUUID } from "node:crypto";

const TYPE: any = "__meshrixRpcType";

export function createPluginProcessRpcPeer({ send, subscribe, onClose = () : any => {} }: Record<string, any> = {}) : any {
  const local: any = new Map<any, any>();
  const remote: any = new Map<any, any>();
  const pending: any = new Map<any, any>();
  let closed: any = false;

  function encode(value?: any, seen: any = new WeakSet<object>()) : any {
    if (value === undefined) return { [TYPE]: "undefined" };
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
    if (typeof value === "function") {
      const ref: any = `fn:${randomUUID()}`;
      local.set(ref, value);
      return { [TYPE]: "function", ref };
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return { [TYPE]: "buffer", value: value.toString("base64") };
    }
    if (value instanceof Date) return { [TYPE]: "date", value: value.toISOString() };
    if (!value || typeof value !== "object" || seen.has(value)) {
      throw new TypeError("Plugin process RPC values must be acyclic structured values.");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry?: any) : any => encode(entry, seen));
      const keys: any = new Set<any>(Object.keys(value));
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor: any = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function") {
          keys.add(key);
        }
      }
      return Object.fromEntries([...keys].map((key?: any) : any => [key, encode(value[key], seen)]));
    } finally {
      seen.delete(value);
    }
  }

  function decode(value?: any) : any {
    if (!value || typeof value !== "object") return value;
    if (value[TYPE] === "undefined") return undefined;
    if (value[TYPE] === "buffer") return Buffer.from(value.value, "base64");
    if (value[TYPE] === "date") return new Date(value.value);
    if (value[TYPE] === "function") {
      if (!remote.has(value.ref)) {
        remote.set(value.ref, (...args: any[]) : any => call(value.ref, args));
      }
      return remote.get(value.ref);
    }
    if (Array.isArray(value)) return value.map(decode);
    return Object.fromEntries((Object.entries(value) as [string, any][]).map(([key, entry]: any[]) : any => [key, decode(entry)]));
  }

  function call(ref?: any, args: any = []) : any {
    if (closed) return Promise.reject(Object.assign(new Error("Plugin process RPC is closed."), { code: "plugin_process_rpc_closed" }));
    const id: any = randomUUID();
    return new Promise((resolve?: any, reject?: any) : any => {
      pending.set(id, { resolve, reject });
      send({ type: "rpc.request", id, ref, args: encode(args) });
    });
  }

  async function receive(message?: any) : Promise<any> {
    if (message?.type === "rpc.request") {
      const fn: any = local.get(message.ref);
      if (!fn) {
        send({ type: "rpc.response", id: message.id, ok: false, error: { code: "plugin_process_rpc_ref_missing", message: "RPC target is unavailable." } });
        return;
      }
      try {
        const value: any = await fn(...decode(message.args));
        send({ type: "rpc.response", id: message.id, ok: true, value: encode(value) });
      } catch (error: any) {
        send({
          type: "rpc.response",
          id: message.id,
          ok: false,
          error: { code: String(error?.code || "plugin_process_rpc_failed"), message: String(error?.message || "RPC call failed.").slice(0, 512) }
        });
      }
      return;
    }
    if (message?.type === "rpc.response") {
      const request: any = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(decode(message.value));
      else request.reject(Object.assign(new Error(message.error?.message || "Plugin process RPC failed."), { code: message.error?.code || "plugin_process_rpc_failed" }));
    }
  }

  subscribe(receive);
  onClose(() : any => {
    closed = true;
    const error: any = Object.assign(new Error("Plugin process terminated."), { code: "plugin_process_terminated" });
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  return Object.freeze({
    register(ref?: any, fn?: any) : any {
      if (typeof fn !== "function") throw new TypeError("RPC registration requires a function.");
      local.set(ref, fn);
    },
    call
  });
}
