// Declarative upstream service configuration entry point.
//
// Watches `<userDataPath>/upstream-config/services.json` and hot-loads the
// declared services into the Meshrix.js upstream gateway: for each service it
// creates or replaces the publication, stores the upstream credential as a
// typed local secret, and binds the credential reference. Internal
// identifiers (capabilityId, secretBindingId, issuer-scopes) are derived
// here and are not part of the file.
//
// File shape:
// {
//   "services": [
//     {
//       "name": "requirement-cognition",
//       "type": "mcp",                       // http | json-rpc | mcp
//       "url": "http://host:8871/mcp",       // remote endpoint
//       "auth": { "type": "bearer", "token": "..." },  // upstream credential
//       "headers": { "x-valorius-project": "dev" }     // non-sensitive context
//     }
//   ]
// }

import fs from "node:fs";
import path from "node:path";

const CONFIG_DIRECTORY = "upstream-config";
const CONFIG_FILENAME = "services.json";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVICES = 256;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63}){0,3}$/u;

function serviceKeyFromName(name: string): string {
  return String(name || "").trim();
}

export function createUpstreamConfigFileLoader({
  userDataPath = "",
  publishingApplication = null,
  localSecretKeyProvider = null,
  onError = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
}: Record<string, any>) : any {
  if (!userDataPath || !publishingApplication?.execute) {
    throw new TypeError("Upstream config file loader requires a data path and a publishing application.");
  }
  const configDir: any = path.join(userDataPath, CONFIG_DIRECTORY);
  const configPath: any = path.join(configDir, CONFIG_FILENAME);
  const interval: any = Math.max(500, Math.min(Number(pollIntervalMs || DEFAULT_POLL_INTERVAL_MS), 60_000));
  let lastMtimeMs: any = 0;
  let lastSize: any = -1;
  let timer: any = null;
  let closed: any = false;
  let applying: any = false;
  let pending: any = false;
  let lastError: any = null;

  // Local maintainer identity for the internal publication path. It mirrors
  // the console owner authority without requiring an interactive session.
  const maintainerSubject: any = Object.freeze({
    subjectId: "meshrix:config-file",
    scopes: Object.freeze(["gateway:admin", "gateway:maintain", "gateway:write", "gateway:read"])
  });

  function parseConfig(raw: string): any {
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
      throw new Error("Upstream config file exceeds the size limit.");
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (error: any) {
      throw new Error(`Upstream config file is not valid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Upstream config file must be an object.");
    }
    const services: any[] = Array.isArray(parsed.services) ? parsed.services : [];
    if (services.length > MAX_SERVICES) {
      throw new Error("Upstream config file declares too many services.");
    }
    return services.map((entry: any, index: number) : any => {
      const name: any = String(entry?.name || "").trim();
      const type: any = String(entry?.type || "").trim();
      const url: any = String(entry?.url || "").trim();
      if (!SAFE_NAME.test(name)) {
        throw new Error(`Upstream config service ${index} has an invalid name.`);
      }
      if (!["http", "json-rpc", "mcp"].includes(type)) {
        throw new Error(`Upstream config service ${name} has an invalid type.`);
      }
      if (!url || !/^https?:\/\/[^/]+:[0-9]{1,5}(?:[/?#]|$)/u.test(url)) {
        throw new Error(`Upstream config service ${name} requires an http(s) URL with an explicit port.`);
      }
      const auth: any = entry?.auth && typeof entry.auth === "object" && !Array.isArray(entry.auth) ? entry.auth : null;
      const headers: any = entry?.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
        ? Object.fromEntries(Object.entries(entry.headers).map(([key, value]: any[]) : any => [String(key), String(value)]))
        : {};
      return Object.freeze({
        name,
        type,
        url,
        auth: auth ? Object.freeze({ type: String(auth.type || "").trim(), token: String(auth.token || "").trim() }) : null,
        headers: Object.freeze(headers)
      });
    });
  }

  function descriptorFor(service: any): any {
    const base: any = {
      serviceProtocol: service.type,
      label: service.name,
      description: `Declared by upstream config file (${service.name}).`,
      allowLocalNetwork: true,
      ...(Object.keys(service.headers).length > 0 ? { mcp: { transport: "http", url: service.url, headers: service.headers } } : {})
    };
    if (service.type === "mcp") {
      return Object.freeze({
        ...base,
        mcp: { transport: "http", url: service.url, ...(Object.keys(service.headers).length > 0 ? { headers: service.headers } : {}) }
      });
    }
    return Object.freeze({
      ...base,
      baseUrl: service.url,
      operations: Object.freeze([Object.freeze({
        operationKey: "default",
        method: "POST",
        path: "/",
        risk: "safe_write",
        payloadTransport: Object.freeze({
          request: Object.freeze({ mode: "structured_json", maxBytes: 1048576, mediaTypes: Object.freeze(["application/json"]) }),
          response: Object.freeze({ mode: "structured_json", maxBytes: 1048576, mediaTypes: Object.freeze(["application/json"]) })
        })
      })])
    });
  }

  async function storeCredential(service: any, serviceId: string): Promise<any> {
    if (!service.auth?.token || !localSecretKeyProvider) return null;
    const secretRef: any = `secret://meshrix/upstream-config/${service.name}`;
    const { initializeLocalSecret } = await import("@meshrix/foundation/security/secrets/local-secret-store");
    const result: any = await initializeLocalSecret({
      dataDir: userDataPath,
      keyProvider: localSecretKeyProvider,
      target: Object.freeze({
        provider: "meshrix",
        family: "http-header",
        authType: "header",
        secretRef,
        scope: Object.freeze({
          serviceId,
          scopes: Object.freeze(["gateway:read", "gateway:write"]),
          allowedHosts: Object.freeze([new URL(service.url).hostname]),
          allowedProtocols: Object.freeze([new URL(service.url).protocol.replace(/:$/, "")])
        })
      }),
      payload: Object.freeze({ headers: Object.freeze({ authorization: service.auth.type === "bearer" ? `Bearer ${service.auth.token}` : service.auth.token }) })
    });
    return Object.freeze({
      type: "credential",
      reference: secretRef,
      revision: Number(result.secret?.revision || 1),
      use: "request-auth",
      host: new URL(service.url).hostname,
      protocol: new URL(service.url).protocol.replace(/:$/, ""),
      scopes: Object.freeze(["gateway:read", "gateway:write"])
    });
  }

  async function findServiceIdByName(name: string): Promise<any> {
    const listed: any = await publishingApplication.list(maintainerSubject);
    const services: any[] = Array.isArray(listed?.services) ? listed.services : [];
    for (const entry of services) {
      const serviceId: any = String(entry?.serviceId || "");
      if (!serviceId) continue;
      let detail: any = null;
      try {
        detail = await publishingApplication.get(serviceId, maintainerSubject);
      } catch {
        continue;
      }
      if (String(detail?.service?.descriptor?.label || "") === name) {
        return Object.freeze({
          serviceId,
          serviceRevision: Number(detail.service.serviceRevision || 0),
          setRevision: Number(listed.setRevision || 0)
        });
      }
    }
    return null;
  }

  async function applyService(service: any): Promise<any> {
    const serviceKey: any = serviceKeyFromName(service.name);
    const descriptor: any = descriptorFor(service);
    const existing: any = await findServiceIdByName(service.name);
    let outcome: any;
    if (existing) {
      const replaceCommand: any = {
        schemaVersion: "v0.0.1:upstream-service-publishing:command-2",
        action: "replace",
        expectedServiceRevision: existing.serviceRevision,
        expectedSetRevision: existing.setRevision,
        idempotencyKey: `config-file-replace:${serviceKey}`,
        serviceId: existing.serviceId,
        descriptor
      };
      outcome = await publishingApplication.execute(JSON.stringify(replaceCommand), maintainerSubject);
    } else {
      const createCommand: any = {
        schemaVersion: "v0.0.1:upstream-service-publishing:command-2",
        action: "create",
        expectedServiceRevision: 0,
        expectedSetRevision: Number((await publishingApplication.list(maintainerSubject))?.setRevision || 0),
        idempotencyKey: `config-file-create:${serviceKey}`,
        serviceKey,
        descriptor
      };
      outcome = await publishingApplication.execute(JSON.stringify(createCommand), maintainerSubject);
    }
    const serviceId: any = String(outcome?.serviceId || "");
    if (!serviceId) throw new Error(`Upstream config service ${service.name} did not produce a service id.`);
    if (service.auth?.token && localSecretKeyProvider) {
      const reference: any = await storeCredential(service, serviceId);
      if (reference) {
        const referenceCommand: any = {
          schemaVersion: "v0.0.1:upstream-service-publishing:command-2",
          action: "replace",
          expectedServiceRevision: Number(outcome.serviceRevision || 0),
          expectedSetRevision: Number(outcome.setRevision || 0),
          idempotencyKey: `config-file-reference:${serviceKey}`,
          serviceId,
          descriptor: Object.freeze({ ...descriptor, references: Object.freeze([reference]) })
        };
        await publishingApplication.execute(JSON.stringify(referenceCommand), maintainerSubject);
      }
    }
    return Object.freeze({ serviceId, serviceKey, status: "applied" });
  }

  async function applyConfig(): Promise<any> {
    let raw: any = null;
    try {
      raw = await fs.promises.readFile(configPath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return Object.freeze({ ok: true, applied: 0 });
      throw error;
    }
    const services: any[] = parseConfig(raw);
    const applied: any[] = [];
    for (const service of services) {
      applied.push(await applyService(service));
    }
    return Object.freeze({ ok: true, applied });
  }

  async function scan(): Promise<any> {
    if (closed) return;
    if (applying) {
      pending = true;
      return;
    }
    applying = true;
    try {
      let stat: any = null;
      try {
        stat = await fs.promises.stat(configPath);
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          lastMtimeMs = 0;
          lastSize = -1;
          return;
        }
        throw error;
      }
      const mtimeMs: any = stat.mtimeMs;
      const size: any = stat.size;
      if (mtimeMs === lastMtimeMs && size === lastSize) return;
      lastMtimeMs = mtimeMs;
      lastSize = size;
      const result: any = await applyConfig();
      lastError = null;
      if (result.applied?.length > 0) {
        onError?.(null, result);
      }
    } catch (error: any) {
      lastError = error;
      onError?.(error, null);
    } finally {
      applying = false;
      if (pending && !closed) {
        pending = false;
        timer = setTimeout(() : any => void scan(), 10);
        timer.unref?.();
      }
    }
  }

  async function start(): Promise<any> {
    await scan();
    if (closed) return;
    timer = setInterval(() : any => void scan(), interval);
    timer.unref?.();
  }

  function close(): Promise<any> {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return Promise.resolve();
  }

  return Object.freeze({
    start,
    close,
    scan,
    get lastError() : any { return lastError; },
    configPath
  });
}
