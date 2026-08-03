import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { authHeaders as connectorAuthHeaders } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
import { createWorkQueueHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-work-queue-handlers.ts";
import {
  buildConsoleState,
  buildRuntimeInfo
} from "../../../packages/protocols/http/api-facade.ts";
import {
  createPolicyEnforcementPoint
} from "../../../packages/foundation/src/security/authorization/pdp/policy-enforcement-point.ts";
import { executeDiscoveryOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/discovery-executor.ts";
import { executeStorageOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.ts";

function captureResponse() : any {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body: any = "") : any {
      this.body = String(body || "");
    },
    json() : any {
      return this.body ? JSON.parse(this.body) : null;
    }
  };
}

describe("P2 security boundaries", () : any => {
  it("keeps connector authentication API-Key-only", () : any => {
    const apiKey: any = `mxak1.${"A".repeat(22)}.${"b".repeat(43)}`;
    expect(connectorAuthHeaders(apiKey, "codex")).not.toHaveProperty("Authorization");
    expect(() : any => connectorAuthHeaders("generic-grant", "codex")).toThrow("strict mxak1");
  });
  it("does not treat a system actor or a caller-provided skip flag as authority", async () : Promise<any> => {
    const auditStore: Record<string, any> = { recordDecision: vi.fn(async () : Promise<any> => {}) };
    const pep: any = createPolicyEnforcementPoint({ auditStore });
    const result: any = await pep.enforce({
      operation: {
        id: "security.system_actor_boundary",
        risk: "safe_write",
        requiredScopes: ["security:write"],
        requiredCapabilities: ["cap:api:security.system_actor_boundary"]
      },
      subject: {
        type: "system",
        subjectId: "system-worker",
        scopes: [],
        capabilities: []
      },
      skipAuthorization: true
    });

    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe("missing_scopes");
    expect(auditStore.recordDecision).toHaveBeenCalledOnce();
  });

  it("requires maintenance admin for global work queue control at the controller boundary", async () : Promise<any> => {
    const pauseWorkQueue: any = vi.fn(async () : Promise<any> => ({ ok: true }));
    const handlers: any = createWorkQueueHandlers({ jobWorkflow: { pauseWorkQueue } });
    const denied: any = captureResponse();

    await handlers.handlePauseWorkQueue({
      requestBody: Buffer.from("{}"),
      response: denied,
      authSession: {
        user: {
          roleId: "maintainer",
          scopes: ["jobs:read", "jobs:write"]
        }
      }
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("work_queue_admin_required");
    expect(pauseWorkQueue).not.toHaveBeenCalled();

    const allowed: any = captureResponse();
    await handlers.handlePauseWorkQueue({
      requestBody: Buffer.from("{}"),
      response: allowed,
      authSession: {
        user: {
          roleId: "maintainer",
          scopes: ["jobs:read", "jobs:write", "maintenance:admin"]
        }
      }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true });
    expect(pauseWorkQueue).toHaveBeenCalledOnce();
  });

  it("redacts local diagnostic fields from console and runtime status projections", async () : Promise<any> => {
    const userDataPath: any = path.resolve("<user-data>");
    const distPath: any = path.resolve("<console-dist>");
    const context: Record<string, any> = {
      userDataPath,
      distPath,
      runtime: null,
      moduleManagement: null,
      discoveryState: {
        offlineAfterSeconds: 30,
        manifestPath: path.join(userDataPath, "device", "servers.json"),
        backendLocation: path.join(userDataPath, "discovery")
      },
      storageProvider: {
        getStorageSummary: () : any => ({
          databasePath: path.join(userDataPath, "metadata", "meshrix.sqlite"),
          objectRootPath: path.join(userDataPath, "objects"),
          backendLocation: path.join(userDataPath, "storage"),
          databaseExists: true,
          objectCount: 7,
          ownedObjectCount: 6,
          deletionOperationCount: 1,
          objectFileCount: 7,
          objectBytes: 4096
        })
      },
      features: {
        activeFeatureIds: ["sample-extension"],
        plugins: {
          consoleEntries: [{
            id: "admin.sample-extension",
            routePath: "/admin/sample-extension",
            filePath: path.join(userDataPath, "plugins", "sample-extension.json"),
            userDataPath,
            path: path.join(userDataPath, "plugins"),
            manifestPath: path.join(userDataPath, "plugins", "sample-extension-manifest.json")
          }]
        }
      },
      serverUrl: "http://127.0.0.1:7391",
      consoleDomainServices: {
        buildAgentSettingsConsoleProjection: async () : Promise<any> => ({
          settings: { path: path.join(userDataPath, "settings.json"), value: {} },
          agentSelector: {},
          agentConfigs: {
            rootPath: path.join(userDataPath, "agents"),
            modelListPath: path.join(userDataPath, "models.json"),
            agentListPath: path.join(userDataPath, "agents.json")
          }
        }),
        buildRuntimeConsoleSummary: async () : Promise<any> => ({
          rootPath: path.join(userDataPath, "runtime"),
          ok: true
        })
      }
    };

    const consoleState: any = await buildConsoleState(context);
    const runtimeInfo: any = await buildRuntimeInfo(context);
    const serialized: any = JSON.stringify({ consoleState, runtimeInfo });

    expect(serialized).not.toContain(userDataPath);
    expect(serialized).not.toContain(distPath);
    expect(serialized).not.toContain("hostname");
    expect(consoleState.server).toEqual({
      url: "http://127.0.0.1:7391",
      localDiagnostics: false
    });
    expect(runtimeInfo.server).toEqual({
      url: "http://127.0.0.1:7391",
      localDiagnostics: false
    });
    expect(consoleState.discovery.value).toEqual({ offlineAfterSeconds: 30 });
    expect(consoleState.storage).toEqual({
      databaseExists: true,
      objectCount: 7,
      ownedObjectCount: 6,
      deletionOperationCount: 1,
      objectFileCount: 7,
      objectBytes: 4096
    });
    expect(runtimeInfo.storage).toEqual(consoleState.storage);
    expect(consoleState.features.plugins.consoleEntries[0]).toEqual({
      id: "admin.sample-extension",
      routePath: "/admin/sample-extension"
    });
  });

  it("projects console-readable storage and discovery operations without server filesystem paths", async () : Promise<any> => {
    const privateRoot: any = path.resolve("<user-data>");
    const storageProvider: Record<string, any> = {
      getStorageSummary: () : any => ({
        databasePath: `${privateRoot}/metadata/meshrix.sqlite`,
        objectRootPath: `${privateRoot}/objects`,
        databaseExists: true,
        objectCount: 2,
        ownedObjectCount: 1,
        deletionOperationCount: 0,
        objectFileCount: 2,
        objectBytes: 256
      }),
      runDoctor: async () : Promise<any> => ({
        userDataPath: privateRoot,
        databasePath: `${privateRoot}/metadata/meshrix.sqlite`,
        jobsRootPath: `${privateRoot}/jobs`,
        objectRootPath: `${privateRoot}/objects`,
        databasePresent: true,
        summary: {
          objectCount: 2,
          ownedObjectCount: 1,
          deletionOperationCount: 0,
          objectFileCount: 2,
          objectBytes: 256,
          jobDirectoryCount: 1
        },
        issues: {
          missingJobMeta: [{ jobId: "job-1", path: `${privateRoot}/jobs/job-1/meta.json` }],
          databaseMissing: [{ databasePath: `${privateRoot}/metadata/meshrix.sqlite` }]
        },
        healthy: false
      })
    };

    const summary: any = await executeStorageOperation({
      operationId: "storage.summary",
      input: {},
      context: { storageProvider }
    });
    const doctor: any = await executeStorageOperation({
      operationId: "storage.doctor",
      input: {},
      context: { storageProvider }
    });
    const discovery: any = await executeDiscoveryOperation({
      operationId: "discovery.get_config",
      input: {},
      context: {
        userDataPath: privateRoot,
        discoveryState: {
          serverId: "server-1",
          serverLabel: "Primary",
          mode: "active",
          configVersion: "revision-1",
          offlineAfterSeconds: 30,
          configFile: `${privateRoot}/discovery.json`
        }
      }
    });

    expect(summary).toEqual({
      status: 200,
      payload: {
        databaseExists: true,
        objectCount: 2,
        ownedObjectCount: 1,
        deletionOperationCount: 0,
        objectFileCount: 2,
        objectBytes: 256
      }
    });
    expect(doctor).toMatchObject({
      status: 200,
      payload: {
        databasePresent: true,
        summary: { objectCount: 2, jobDirectoryCount: 1 },
        issues: {
          missingJobMeta: [{ jobId: "job-1" }],
          databaseMissing: [{}]
        },
        healthy: false
      }
    });
    expect(discovery.payload).not.toHaveProperty("path");
    expect(discovery.payload.value).toEqual({
      serverId: "server-1",
      serverLabel: "Primary",
      mode: "active",
      configVersion: "revision-1",
      offlineAfterSeconds: 30
    });
    expect(JSON.stringify({ summary, doctor, discovery })).not.toContain(privateRoot);
  });
});
