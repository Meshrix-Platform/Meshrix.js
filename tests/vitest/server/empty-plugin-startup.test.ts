import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";
import { createConsoleAuth } from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";

const resources: any[] = [];

afterEach(async () : Promise<any> => {
  for (const close of resources.splice(0).reverse()) await close();
});

function cookieHeader(response?: any) : any {
  const values: any = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value?: any) : any => value.split(";")[0]).join("; ");
}

describe("empty plugin startup", () : any => {
  it("starts Core with no installed plugin contributions and no implicit agent project", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-empty-plugin-startup-"));
    resources.push(() : any => fs.rm(userDataPath, { recursive: true, force: true }));

    const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
    const auth: any = createConsoleAuth({ userDataPath, tagManagementStore });
    const owner: any = await auth.ensureInitialOwner();
    await auth.close();
    tagManagementStore.close();

    const server: any = await startHttpServer({
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
    resources.push(() : any => server.close());

    const login: any = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: owner.username, password: owner.password })
    });
    const loginPayload: any = await login.json();
    expect(login.status).toBe(200);
    const readHeaders: Record<string, any> = { cookie: cookieHeader(login) };
    const writeHeaders: Record<string, any> = {
      ...readHeaders,
      "content-type": "application/json",
      "x-meshrix-csrf": loginPayload.csrfToken,
      "x-meshrix-safety-confirm": "true"
    };

    const interfacesResponse: any = await fetch(`${server.url}/api/interfaces`, { headers: readHeaders });
    const interfaces: any = await interfacesResponse.json();
    expect(interfacesResponse.status).toBe(200);
    expect(interfaces.features.plugins).toMatchObject({
      loadedPlugins: [],
      effectivePlugins: [],
      consoleEntries: [],
      stateMachines: []
    });
    expect(interfaces.features.plugins.routes).toEqual([]);

    const initialWorkspacesResponse: any = await fetch(`${server.url}/api/agent-workspaces`, {
      headers: readHeaders
    });
    const initialWorkspaces: any = await initialWorkspacesResponse.json();
    expect(initialWorkspacesResponse.status).toBe(200);
    expect(initialWorkspaces.workspaces).toEqual([]);

    const createWorkspace: any = await fetch(`${server.url}/api/agent-workspaces`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({ title: "Synthetic empty-plugin workspace" })
    });
    const created: any = await createWorkspace.json();
    expect(createWorkspace.status).toBe(201);
    const workspaceId: any = created.workspace?.workspaceId;
    expect(workspaceId).toEqual(expect.any(String));

    const readWorkspace: any = await fetch(`${server.url}/api/agent-workspaces/${workspaceId}`, {
      headers: readHeaders
    });
    expect(readWorkspace.status).toBe(200);
    expect(await readWorkspace.json()).toMatchObject({ workspace: { workspaceId } });
  });
});
