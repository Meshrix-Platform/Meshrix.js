import { describe, expect, it, vi } from "vitest";

import {
  handlePluginConsoleAssetRequest,
  MAX_CONSOLE_ASSET_BYTES
} from "../../../apps/server/runtime/http-server-plugin-console-assets.ts";

const ASSET_URL: any = `/api/plugins/v1/console-assets/demo/1/${"a".repeat(64)}/entry/asset.ts`;
const ENTRY: Readonly<Record<string, any>> = Object.freeze({
  id: "admin.demo",
  pluginId: "demo",
  requiredScopes: Object.freeze(["demo:read"]),
  artifactDigest: `sha256:${"a".repeat(64)}`,
  artifactGeneration: 1
});

function capturedResponse() : any {
  const headers: any = new Map<any, any>();
  return {
    statusCode: 0,
    body: undefined,
    headers,
    setHeader(name?: any, value?: any) : any {
      headers.set(String(name).toLowerCase(), String(value));
    },
    writeHead(statusCode?: any, values: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      for (const [name, value] of (Object.entries(values) as [string, any][])) this.setHeader(name, value);
    },
    end(body?: any) : any {
      this.body = body;
    }
  };
}

function dependencies({ session = null, entry = ENTRY, assetEntry = ENTRY, bytes = Buffer.from("export {};") }: Record<string, any> = {}) : any {
  return {
    consoleAuth: { getSessionFromRequest: vi.fn(() : any => session) },
    pluginContributions: {
      getConsoleAssetEntry: vi.fn(() : any => entry),
      readConsoleAsset: vi.fn(async () : Promise<any> => entry ? { entry: assetEntry, bytes } : null)
    }
  };
}

async function invoke({ method = "GET", pathname = ASSET_URL, ...patch }: Record<string, any> = {}) : Promise<any> {
  const response: any = capturedResponse();
  const deps: any = dependencies(patch);
  const handled: any = await handlePluginConsoleAssetRequest({
    request: {},
    response,
    method,
    url: new URL(`http://localhost${pathname}`),
    ...deps
  });
  return { handled, response, ...deps };
}

describe("plugin console asset HTTP boundary", () : any => {
  it("ignores unrelated routes and rejects unsupported methods", async () : Promise<any> => {
    const unrelated: any = await invoke({ pathname: "/api/system/status" });
    expect(unrelated.handled).toBe(false);

    const rejected: any = await invoke({ method: "POST" });
    expect(rejected.handled).toBe(true);
    expect(rejected.response.statusCode).toBe(405);
    expect(rejected.response.headers.get("allow")).toBe("GET, HEAD");
    expect(rejected.pluginContributions.readConsoleAsset).not.toHaveBeenCalled();
  });

  it("requires a current authenticated session and every declared scope before reading bytes", async () : Promise<any> => {
    const anonymous: any = await invoke();
    expect(anonymous.response.statusCode).toBe(401);
    expect(anonymous.pluginContributions.readConsoleAsset).not.toHaveBeenCalled();

    const denied: any = await invoke({ session: { user: { scopes: [] } } });
    expect(denied.response.statusCode).toBe(403);
    expect(denied.pluginContributions.readConsoleAsset).not.toHaveBeenCalled();

    const missing: any = await invoke({ session: { user: { scopes: ["demo:read"] } }, entry: null });
    expect(missing.response.statusCode).toBe(404);
    expect(missing.pluginContributions.readConsoleAsset).not.toHaveBeenCalled();
  });

  it("serves only the current bound module with restrictive response headers", async () : Promise<any> => {
    const bytes: any = Buffer.from("export function mountPluginConsole() {}\n");
    const served: any = await invoke({ session: { user: { scopes: ["demo:read"] } }, bytes });

    expect(served.response.statusCode).toBe(200);
    expect(served.response.body).toEqual(bytes);
    expect(served.response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(served.response.headers.get("content-length")).toBe(String(bytes.length));
    expect(served.response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(served.response.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const head: any = await invoke({ method: "HEAD", session: { user: { scopes: ["demo:read"] } }, bytes });
    expect(head.response.statusCode).toBe(200);
    expect(head.response.body).toBeUndefined();
    expect(head.response.headers.get("content-length")).toBe(String(bytes.length));
  });

  it("fails closed when the artifact identity drifts or the module exceeds its byte budget", async () : Promise<any> => {
    const drifted: any = await invoke({
      session: { user: { scopes: ["demo:read"] } },
      assetEntry: { ...ENTRY, artifactGeneration: 2 }
    });
    expect(drifted.response.statusCode).toBe(404);

    const oversized: any = await invoke({
      session: { user: { scopes: ["demo:read"] } },
      bytes: Buffer.alloc(MAX_CONSOLE_ASSET_BYTES + 1)
    });
    expect(oversized.response.statusCode).toBe(404);
    expect(oversized.response.body.toString()).not.toContain("demo");

    const response: any = capturedResponse();
    const handled: any = await handlePluginConsoleAssetRequest({
      request: {},
      response,
      method: "GET",
      url: new URL(`http://localhost${ASSET_URL}`),
      consoleAuth: { getSessionFromRequest: () : any => ({ user: { scopes: ["demo:read"] } }) },
      pluginContributions: {
        getConsoleAssetEntry: () : any => ENTRY,
        readConsoleAsset: async () : Promise<any> => {
          throw new Error("sensitive provider detail");
        }
      }
    });
    expect(handled).toBe(true);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("sensitive provider detail");
  });
});
