import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";
import { parseWithDuplicateRejection } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import { useIsolatedCapabilityKernelForVerifier } from "../../../tools/server-scripts/capability-kernel-test-env.ts";
import { createUpstreamPublishingHostileCorpus } from "../../../tools/server-scripts/lib/upstream-publishing-hostile-corpus.ts";

const resources: any[] = [];

afterEach(async () : Promise<any> => {
  for (const release of resources.splice(0).reverse()) {
    await release();
  }
});

function cookieHeader(response?: any) : any {
  const values: any = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value?: any) : any => value.split(";")[0]).join("; ");
}

async function login(baseUrl?: any, username?: any, password?: any) : Promise<any> {
  const response: any = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload: any = await response.json();
  expect(response.status).toBe(200);
  const cookie: any = cookieHeader(response);
  return {
    read: { cookie },
    write: {
      cookie,
      "content-type": "application/json",
      "x-meshrix-csrf": payload.csrfToken,
      "x-meshrix-safety-confirm": "true"
    }
  };
}

async function startFixture() : Promise<any> {
  let calls: any = 0;
  const server: any = http.createServer((request?: any, response?: any) : any => {
    calls += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve?: any) : any => server.listen(0, "127.0.0.1", resolve));
  resources.push(() : any => new Promise((resolve?: any) : any => server.close(resolve)));
  const address: any = server.address();
  return { url: `http://127.0.0.1:${address.port}`, calls: () : any => calls };
}

async function startProductionServer() : Promise<any> {
  const restoreKernel: any = useIsolatedCapabilityKernelForVerifier();
  resources.push(async () : Promise<any> => restoreKernel());
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-raw-boundary-"));
  resources.push(() : any => fs.rm(userDataPath, { recursive: true, force: true }));
  const tagStore: any = createTagStoreAdapter({ userDataPath });
  const auth: any = createConsoleAuth({ userDataPath, tagManagementStore: tagStore });
  const owner: any = await auth.ensureInitialOwner();
  await auth.close();
  tagStore.close();
  const server: any = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    runtimeOptions: { disableFileLogging: true }
  });
  resources.push(() : any => server.close());
  return { server, session: await login(server.url, owner.username, owner.password) };
}

describe("upstream publishing hostile raw-byte boundary", () : any => {
  it("enforces independent member, item, total-value, depth, and byte budgets in one scan", () : any => {
    const fixtureUrl: any = "https://service.invalid:443";
    const byId: any = new Map<any, any>(createUpstreamPublishingHostileCorpus(fixtureUrl).map(({ id, raw }: Record<string, any>) : any => [id, raw]));
    for (const id of ["byte-limit", "depth-limit", "object-cardinality", "array-cardinality", "total-cardinality"]) {
      expect(() : any => parseWithDuplicateRejection(byId.get(id)), id).toThrow();
    }
  });

  it("publishes allowed MCP context headers without treating them as executable input", async () : Promise<any> => {
    const fixture: any = await startFixture();
    const { server, session } = await startProductionServer();
    const collection: any = `${server.url}/api/gateway/v1/services`;
    const command: any = {
      schemaVersion: "v0.0.1:upstream-service-publishing:command-2",
      action: "create",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      idempotencyKey: "fixture-positive-mcp-context-header",
      serviceKey: "fixture-context-service",
      descriptor: {
        serviceProtocol: "mcp",
        label: "Fixture context service",
        allowLocalNetwork: true,
        mcp: {
          transport: "http",
          url: `${fixture.url}/mcp`,
          headers: { "x-fixture-context": "alpha" }
        }
      }
    };
    const created: any = await fetch(collection, {
      method: "POST",
      headers: session.write,
      body: JSON.stringify(command)
    });
    expect(created.status).toBe(202);
    const payload: any = await created.json();
    const detail: any = await fetch(`${collection}/${encodeURIComponent(payload.serviceId)}`, {
      headers: session.read
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).service.descriptor.mcp.headers).toEqual({
      "x-fixture-context": "alpha"
    });
  });

  it("rejects the bounded corpus through REST and JSON-RPC with zero publication or network side effects", async () : Promise<any> => {
    const fixture: any = await startFixture();
    const { server, session } = await startProductionServer();
    const collection: any = `${server.url}/api/gateway/v1/services`;
    for (const { id, raw } of createUpstreamPublishingHostileCorpus(fixture.url)) {
      const rest: any = await fetch(collection, { method: "POST", headers: session.write, body: raw });
      expect(rest.status, `REST ${id}`).toBe(id === "byte-limit" ? 413 : 400);

      const rpc: any = await fetch(`${server.url}/api/rpc`, {
        method: "POST",
        headers: session.write,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `raw-${id}`,
          method: "external_services.create",
          params: { bodyText: raw }
        })
      });
      expect(rpc.status, `RPC transport ${id}`).toBe(200);
      expect(await rpc.json(), `RPC ${id}`).toMatchObject({ error: { code: 400 } });
    }

    const projectedRpc: any = await fetch(`${server.url}/api/rpc`, {
      method: "POST",
      headers: session.write,
      body: '{"jsonrpc":"2.0","id":"projected","method":"external_services.create","params":{"action":"create","action":"replace"}}'
    });
    expect(await projectedRpc.json()).toMatchObject({ error: { code: 400 } });

    const publications: any = await fetch(collection, { headers: session.read });
    expect(await publications.json()).toMatchObject({ ok: true, setRevision: 0, services: [] });
    const runtime: any = await fetch(`${server.url}/api/gateway/v1/external-services`, { headers: session.read });
    expect(await runtime.json()).toMatchObject({ items: [] });
    expect(fixture.calls()).toBe(0);
  });
});
