import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.mjs";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.mjs";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

const resources = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";")[0]).join("; ");
}

describe("empty plugin startup", () => {
  it("starts Core with no installed plugin contributions and no implicit agent project", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-empty-plugin-startup-"));
    resources.push(() => fs.rm(userDataPath, { recursive: true, force: true }));

    const tagManagementStore = createTagStoreAdapter({ userDataPath });
    const auth = createConsoleAuth({ userDataPath, tagManagementStore });
    const owner = await auth.ensureInitialOwner();
    await auth.close();
    tagManagementStore.close();

    const server = await startHttpServer({
      userDataPath,
      distPath: "",
      runtimeOptions: {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        enabledPlugins: [],
        pluginConfigurations: {},
        disableFileLogging: true
      },
      host: "127.0.0.1",
      port: 0
    });
    resources.push(() => server.close());

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: owner.username, password: owner.password })
    });
    const loginPayload = await login.json();
    expect(login.status).toBe(200);
    const readHeaders = { cookie: cookieHeader(login) };
    const writeHeaders = {
      ...readHeaders,
      "content-type": "application/json",
      "x-lico-csrf": loginPayload.csrfToken,
      "x-lico-safety-confirm": "true"
    };

    const interfacesResponse = await fetch(`${server.url}/api/interfaces`, { headers: readHeaders });
    const interfaces = await interfacesResponse.json();
    expect(interfacesResponse.status).toBe(200);
    expect(interfaces.features.plugins).toMatchObject({
      loadedPlugins: [],
      effectivePlugins: [],
      consoleEntries: [],
      stateMachines: []
    });
    expect(interfaces.features.plugins.routes).toEqual([]);

    const initialWorkspacesResponse = await fetch(`${server.url}/api/agent-workspaces`, {
      headers: readHeaders
    });
    const initialWorkspaces = await initialWorkspacesResponse.json();
    expect(initialWorkspacesResponse.status).toBe(200);
    expect(initialWorkspaces.workspaces).toEqual([]);

    const createWorkspace = await fetch(`${server.url}/api/agent-workspaces`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ title: "Synthetic empty-plugin workspace" })
    });
    const created = await createWorkspace.json();
    expect(createWorkspace.status).toBe(201);
    const workspaceId = created.workspace?.workspaceId;
    expect(workspaceId).toEqual(expect.any(String));

    const readWorkspace = await fetch(`${server.url}/api/agent-workspaces/${workspaceId}`, {
      headers: readHeaders
    });
    expect(readWorkspace.status).toBe(200);
    expect(await readWorkspace.json()).toMatchObject({ workspace: { workspaceId } });
  });
});
