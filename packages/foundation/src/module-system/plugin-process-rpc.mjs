import { randomUUID } from "node:crypto";

const TYPE = "__licoRpcType";

export function createPluginProcessRpcPeer({ send, subscribe, onClose = () => {} } = {}) {
  const local = new Map();
  const remote = new Map();
  const pending = new Map();
  let closed = false;

  function encode(value, seen = new WeakSet()) {
    if (value === undefined) return { [TYPE]: "undefined" };
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
    if (typeof value === "function") {
      const ref = `fn:${randomUUID()}`;
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
      if (Array.isArray(value)) return value.map((entry) => encode(entry, seen));
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry, seen)]));
    } finally {
      seen.delete(value);
    }
  }

  function decode(value) {
    if (!value || typeof value !== "object") return value;
    if (value[TYPE] === "undefined") return undefined;
    if (value[TYPE] === "buffer") return Buffer.from(value.value, "base64");
    if (value[TYPE] === "date") return new Date(value.value);
    if (value[TYPE] === "function") {
      if (!remote.has(value.ref)) {
        remote.set(value.ref, (...args) => call(value.ref, args));
      }
      return remote.get(value.ref);
    }
    if (Array.isArray(value)) return value.map(decode);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }

  function call(ref, args = []) {
    if (closed) return Promise.reject(Object.assign(new Error("Plugin process RPC is closed."), { code: "plugin_process_rpc_closed" }));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "rpc.request", id, ref, args: encode(args) });
    });
  }

  async function receive(message) {
    if (message?.type === "rpc.request") {
      const fn = local.get(message.ref);
      if (!fn) {
        send({ type: "rpc.response", id: message.id, ok: false, error: { code: "plugin_process_rpc_ref_missing", message: "RPC target is unavailable." } });
        return;
      }
      try {
        const value = await fn(...decode(message.args));
        send({ type: "rpc.response", id: message.id, ok: true, value: encode(value) });
      } catch (error) {
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
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(decode(message.value));
      else request.reject(Object.assign(new Error(message.error?.message || "Plugin process RPC failed."), { code: message.error?.code || "plugin_process_rpc_failed" }));
    }
  }

  subscribe(receive);
  onClose(() => {
    closed = true;
    const error = Object.assign(new Error("Plugin process terminated."), { code: "plugin_process_terminated" });
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  return Object.freeze({
    register(ref, fn) {
      if (typeof fn !== "function") throw new TypeError("RPC registration requires a function.");
      local.set(ref, fn);
    },
    call
  });
}
