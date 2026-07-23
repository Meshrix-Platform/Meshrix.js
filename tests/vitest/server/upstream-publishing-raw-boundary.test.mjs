import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.mjs";
import { parseWithDuplicateRejection } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.mjs";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.mjs";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "../../../tools/server-scripts/capability-kernel-test-env.mjs";
import { createUpstreamPublishingHostileCorpus } from "../../../tools/server-scripts/lib/upstream-publishing-hostile-corpus.mjs";

const resources = [];

afterEach(async () => {
  for (const release of resources.splice(0).reverse()) {
    await release();
  }
});

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";")[0]).join("; ");
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  expect(response.status).toBe(200);
  const cookie = cookieHeader(response);
  return {
    read: { cookie },
    write: {
      cookie,
      "content-type": "application/json",
      "x-lico-csrf": payload.csrfToken,
      "x-lico-safety-confirm": "true"
    }
  };
}

async function startFixture() {
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, calls: () => calls };
}

async function startProductionServer() {
  const restoreKernel = useIsolatedCapabilityKernelForVerifier();
  resources.push(async () => restoreKernel());
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-raw-boundary-"));
  resources.push(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const tagStore = createTagStoreAdapter({ userDataPath });
  const auth = createConsoleAuth({ userDataPath, tagManagementStore: tagStore });
  const owner = await auth.ensureInitialOwner();
  await auth.close();
  tagStore.close();
  const server = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    runtimeOptions: { disableFileLogging: true }
  });
  resources.push(() => server.close());
  return { server, session: await login(server.url, owner.username, owner.password) };
}

describe("upstream publishing hostile raw-byte boundary", () => {
  it("enforces independent member, item, total-value, depth, and byte budgets in one scan", () => {
    const fixtureUrl = "https://service.invalid:443";
    const byId = new Map(createUpstreamPublishingHostileCorpus(fixtureUrl).map(({ id, raw }) => [id, raw]));
    for (const id of ["byte-limit", "depth-limit", "object-cardinality", "array-cardinality", "total-cardinality"]) {
      expect(() => parseWithDuplicateRejection(byId.get(id)), id).toThrow();
    }
  });

  it("rejects the bounded corpus through REST and JSON-RPC with zero publication or network side effects", async () => {
    const fixture = await startFixture();
    const { server, session } = await startProductionServer();
    const collection = `${server.url}/api/gateway/v1/services`;
    for (const { id, raw } of createUpstreamPublishingHostileCorpus(fixture.url)) {
      const rest = await fetch(collection, { method: "POST", headers: session.write, body: raw });
      expect(rest.status, `REST ${id}`).toBe(id === "byte-limit" ? 413 : 400);

      const rpc = await fetch(`${server.url}/api/rpc`, {
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

    const projectedRpc = await fetch(`${server.url}/api/rpc`, {
      method: "POST",
      headers: session.write,
      body: '{"jsonrpc":"2.0","id":"projected","method":"external_services.create","params":{"action":"create","action":"replace"}}'
    });
    expect(await projectedRpc.json()).toMatchObject({ error: { code: 400 } });

    const publications = await fetch(collection, { headers: session.read });
    expect(await publications.json()).toMatchObject({ ok: true, setRevision: 0, services: [] });
    const runtime = await fetch(`${server.url}/api/gateway/v1/external-services`, { headers: session.read });
    expect(await runtime.json()).toMatchObject({ items: [] });
    expect(fixture.calls()).toBe(0);
  });
});
