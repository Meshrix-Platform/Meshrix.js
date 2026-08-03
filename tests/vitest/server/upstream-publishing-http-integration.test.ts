import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "../../../packages/agents/src/upstream-gateway/publishing-application.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

const roots: any[] = [];
const servers: any[] = [];

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
  return {
    read: { cookie: cookieHeader(response) },
    write: {
      cookie: cookieHeader(response),
      "content-type": "application/json",
      "x-meshrix-csrf": payload.csrfToken,
      "x-meshrix-safety-confirm": "true"
    }
  };
}

function createCommand() : any {
  return {
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    serviceKey: "inventory",
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "create-inventory",
    descriptor: {
      serviceProtocol: "http",
      baseUrl: "https://service.invalid:443",
      references: [],
      operations: [{
        operationKey: "read", method: "GET", path: "/read",
        payloadTransport: structuredJsonPayloadTransport()
      }]
    }
  };
}

async function waitForServerPublication(url?: any, serviceId?: any, headers?: any) : Promise<any> {
  let payload: any = null;
  for (let attempt: any = 0; attempt < 40; attempt += 1) {
    const response: any = await fetch(`${url}/${encodeURIComponent(serviceId)}`, { headers });
    expect(response.status).toBe(200);
    payload = await response.json();
    if (payload.service?.publication?.status === "server_published") return payload;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  return payload;
}

afterEach(async () : Promise<any> => {
  await Promise.all(servers.splice(0).map((server?: any) : any => server.close().catch(() : any => {})));
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("production upstream publishing HTTP composition", () : any => {
  it("enforces auth, ownership, raw parsing, CAS and replay through the registered route", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-http-"));
    roots.push(userDataPath);
    const tagStore: any = createTagStoreAdapter({ userDataPath });
    const auth: any = createConsoleAuth({ userDataPath, tagManagementStore: tagStore });
    const owner: any = await auth.ensureInitialOwner();
    const otherPassword: any = "other-admin-fixture-credential";
    const viewerPassword: any = "viewer-fixture-credential";
    await auth.createUser({ username: "other.maintainer", password: otherPassword, roleId: "maintainer" });
    await auth.createUser({ username: "read.viewer", password: viewerPassword, roleId: "viewer" });
    await auth.close();
    tagStore.close();

    const server: any = await startHttpServer({
      userDataPath,
      distPath: "",
      host: "127.0.0.1",
      port: 0,
      runtimeOptions: { disableFileLogging: true }
    });
    servers.push(server);
    const ownerSession: any = await login(server.url, owner.username, owner.password);
    const otherSession: any = await login(server.url, "other.maintainer", otherPassword);
    const viewerSession: any = await login(server.url, "read.viewer", viewerPassword);
    const url: any = `${server.url}/api/gateway/v1/services`;

    const unauthenticated: any = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createCommand())
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden: any = await fetch(url, {
      method: "POST",
      headers: viewerSession.write,
      body: JSON.stringify(createCommand())
    });
    expect(forbidden.status).toBe(403);

    const accepted: any = await fetch(url, {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify(createCommand())
    });
    const first: any = await accepted.json();
    expect(accepted.status).toBe(202);
    expect(first).toMatchObject({
      ok: true,
      state: "publishing",
      serviceRevision: 1,
      setRevision: 1,
      publication: { status: "publishing", candidateRevision: 1 },
      replayed: false
    });

    const replayed: any = await fetch(url, {
      method: "POST",
      headers: ownerSession.write,
      body: JSON.stringify(createCommand())
    });
    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toMatchObject({ serviceRevision: 1, setRevision: 1, replayed: true });

    const crossOwner: any = await fetch(`${url}/${encodeURIComponent(first.serviceId)}`, {
      method: "PUT",
      headers: otherSession.write,
      body: JSON.stringify({
        ...createCommand(),
        action: "replace",
        serviceKey: undefined,
        serviceId: first.serviceId,
        expectedServiceRevision: 1,
        expectedSetRevision: 1,
        idempotencyKey: "cross-owner-replace"
      })
    });
    expect(crossOwner.status).toBe(403);

    const replaceCommand: any = (label?: any, idempotencyKey?: any) : any => ({
      schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
      action: "replace",
      serviceId: first.serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      idempotencyKey,
      descriptor: {
        serviceProtocol: "http",
        label,
        baseUrl: "https://service.invalid:443",
        references: [],
        operations: [{
          operationKey: "read", method: "GET", path: "/read",
          payloadTransport: structuredJsonPayloadTransport()
        }]
      }
    });
    const concurrent: any = await Promise.all([
      fetch(`${url}/${encodeURIComponent(first.serviceId)}`, {
        method: "PUT",
        headers: ownerSession.write,
        body: JSON.stringify(replaceCommand("First", "replace-first"))
      }),
      fetch(`${url}/${encodeURIComponent(first.serviceId)}`, {
        method: "PUT",
        headers: ownerSession.write,
        body: JSON.stringify(replaceCommand("Second", "replace-second"))
      })
    ]);
    expect(concurrent.map((response?: any) : any => response.status).sort()).toEqual([202, 409]);

    const duplicate: any = JSON.stringify(createCommand()).replace(
      '"action":"create"',
      '"action":"create","action":"replace"'
    );
    const invalid: any = await fetch(url, { method: "POST", headers: ownerSession.write, body: duplicate });
    expect(invalid.status).toBe(400);

    const list: any = await fetch(url, { headers: ownerSession.read });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      ok: true,
      setRevision: 2,
      services: [{ serviceId: first.serviceId, state: "publishing", serviceRevision: 2 }]
    });

    let runtimePayload: any = null;
    for (let attempt: any = 0; attempt < 20; attempt += 1) {
      const runtimeList: any = await fetch(`${server.url}/api/gateway/v1/external-services`, { headers: ownerSession.read });
      runtimePayload = await runtimeList.json();
      if (runtimePayload.items?.some((service?: any) : any => service.serviceId === first.serviceId)) break;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
    }
    expect(runtimePayload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceId: first.serviceId, operations: [expect.objectContaining({ operationKey: "read" })] })
    ]));
    const published: any = await waitForServerPublication(url, first.serviceId, ownerSession.read);
    expect(published.service.publication).toMatchObject({
      status: "server_published",
      candidateRevision: 2,
      terminal: {
        sourceRevision: 2,
        sourceDigest: expect.any(String),
        catalogRevision: expect.any(String),
        audienceRevision: expect.any(Number),
        protocolRevision: expect.any(Number)
      }
    });
    expect(published.service.publication.terminal.sourceDigest).toBe(
      published.service.publication.candidateDigest
    );

    await server.close();
    servers.pop();
    const restarted: any = await startHttpServer({
      userDataPath,
      distPath: "",
      host: "127.0.0.1",
      port: 0,
      runtimeOptions: { disableFileLogging: true }
    });
    servers.push(restarted);
    const restartedSession: any = await login(restarted.url, owner.username, owner.password);
    const afterRestart: any = await fetch(`${restarted.url}/api/gateway/v1/external-services`, { headers: restartedSession.read });
    expect(await afterRestart.json()).toMatchObject({
      items: [expect.objectContaining({ serviceId: first.serviceId })]
    });
    const restartedPublication: any = await waitForServerPublication(
      `${restarted.url}/api/gateway/v1/services`,
      first.serviceId,
      restartedSession.read
    );
    expect(restartedPublication.service.publication).toMatchObject({
      status: "server_published",
      candidateRevision: 2,
      terminal: { sourceRevision: 2 }
    });
  });

  it("streams opaque bytes through the authenticated production transit route", async () : Promise<any> => {
    const observed: any[] = [];
    const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      for await (const chunk of request) observed.push(Buffer.from(chunk));
      response.writeHead(201, {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=converted.bin"
      });
      response.write(Buffer.from([0x00, 0xff]));
      response.end(Buffer.from([0x41, 0x42]));
    });
    await new Promise((resolve?: any, reject?: any) : any => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    servers.push({ close: () : any => new Promise((resolve?: any) : any => upstream.close(resolve)) });

    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-stream-http-"));
    roots.push(userDataPath);
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
    servers.push(server);
    const session: any = await login(server.url, owner.username, owner.password);
    const command: any = createCommand();
    command.serviceKey = "file-parser/format-convert";
    command.idempotencyKey = "publish-binary-converter";
    command.descriptor = {
      serviceProtocol: "http",
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      allowLocalNetwork: true,
      references: [],
      operations: [{
        operationKey: "convert",
        method: "POST",
        path: "/convert",
        risk: "safe_write",
        requiredScopes: ["gateway:write"],
        payloadTransport: {
          request: { mode: "opaque_stream", maxBytes: 1024, mediaTypes: ["application/octet-stream"] },
          response: { mode: "opaque_stream", maxBytes: 1024, mediaTypes: ["application/octet-stream"] }
        }
      }]
    };
    const publishedResponse: any = await fetch(`${server.url}/api/gateway/v1/services`, {
      method: "POST",
      headers: session.write,
      body: JSON.stringify(command)
    });
    expect(publishedResponse.status).toBe(202);
    const published: any = await publishedResponse.json();
    await waitForServerPublication(`${server.url}/api/gateway/v1/services`, published.serviceId, session.read);

    const expectRejected: any = await new Promise((resolve?: any, reject?: any) : any => {
      let continued: any = false;
      const request: any = http.request(
        `${server.url}/api/gateway/v1/transit/${encodeURIComponent(published.serviceId)}/convert`,
        {
          method: "POST",
          headers: {
            ...session.write,
            expect: "100-continue",
            "content-type": "application/octet-stream",
            "content-length": "2048"
          }
        },
        (response?: any) : any => {
          response.resume();
          response.once("end", () : any => resolve({ status: response.statusCode, continued }));
        }
      );
      request.once("continue", () : any => {
        continued = true;
        request.end(Buffer.alloc(2048));
      });
      request.once("error", reject);
      request.flushHeaders();
    });
    expect(expectRejected).toEqual({ status: 413, continued: false });
    expect(observed).toHaveLength(0);

    const requestBytes: any = Buffer.from([0x10, 0x00, 0xfe, 0x7f]);
    const transit: any = await fetch(
      `${server.url}/api/gateway/v1/transit/${encodeURIComponent(published.serviceId)}/convert`,
      {
        method: "POST",
        headers: { ...session.write, "content-type": "application/octet-stream" },
        body: requestBytes
      }
    );
    expect(transit.status).toBe(201);
    expect(transit.headers.get("content-disposition")).toBe("attachment; filename=converted.bin");
    expect(Buffer.from(await transit.arrayBuffer())).toEqual(Buffer.from([0x00, 0xff, 0x41, 0x42]));
    expect(Buffer.concat(observed)).toEqual(requestBytes);
  });
});
