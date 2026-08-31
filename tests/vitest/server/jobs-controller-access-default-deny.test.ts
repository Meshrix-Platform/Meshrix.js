import { describe, expect, it, vi } from "vitest";

import {
  apiKeyUploadAuthSession,
  canAccessJob,
  canAccessRawObjectEntry,
  filterJobsForCaller
} from "../../../packages/protocols/http/controllers/jobs-controller-access.ts";
import { createJobArtifactHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-artifact-handlers.ts";

function responseRecorder() : any {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    end(payload?: any) : any {
      this.payload = JSON.parse(payload);
    }
  };
}

const OWNER_SESSION: Readonly<Record<string, any>> = Object.freeze({
  user: Object.freeze({
    subjectId: "job-owner",
    userId: "job-owner",
    scopes: Object.freeze(["jobs:read"])
  })
});

const JOB: Readonly<Record<string, any>> = Object.freeze({
  id: "job-private",
  status: "completed",
  ownerSubjectId: "job-owner",
  workspaceId: "workspace-api-key"
});

function scopedApiKeySession() : any {
  return apiKeyUploadAuthSession(Object.freeze({
    credentialKind: "scoped_api_key",
    workloadPrincipalId: "api-key-workload",
    organizationNodeId: "organization:fixture",
    lifecycleRevision: 1,
    policy: Object.freeze({
      scopeIds: Object.freeze(["jobs:read"]),
      resources: Object.freeze({
        workspaceIds: Object.freeze(["workspace-api-key"])
      })
    })
  }));
}

describe("jobs controller access default deny", () : any => {
  it("denies missing internal identity and filters every private job", () : any => {
    expect(canAccessJob(JOB, null)).toBe(false);
    expect(canAccessJob(JOB, {})).toBe(false);
    expect(filterJobsForCaller([JOB], null)).toEqual([]);
    expect(filterJobsForCaller({ items: [JOB] }, null)).toMatchObject({
      items: [],
      summary: { totalCount: 0 }
    });
  });

  it("keeps owner Console sessions and workspace-scoped API Keys authorized", () : any => {
    expect(canAccessJob(JOB, OWNER_SESSION)).toBe(true);
    expect(canAccessJob(JOB, scopedApiKeySession())).toBe(true);
  });

  it("denies a raw object when identity is absent and keeps bound API Key access", async () : Promise<any> => {
    const rawObjectEntry: Record<string, any> = {
      rawObject: {
        jobId: JOB.id
      }
    };
    const getJob: any = vi.fn(async () : Promise<any> => JOB);

    await expect(canAccessRawObjectEntry(rawObjectEntry, null, { getJob })).resolves.toBe(false);
    expect(getJob).not.toHaveBeenCalled();

    await expect(
      canAccessRawObjectEntry(rawObjectEntry, scopedApiKeySession(), { getJob })
    ).resolves.toBe(true);
    expect(getJob).toHaveBeenCalledWith(JOB.id);
  });

  it("does not read or emit job results when internal identity is absent", async () : Promise<any> => {
    const getJobResult: any = vi.fn(async () : Promise<any> => ({ private: true }));
    const handlers: any = createJobArtifactHandlers({
      userDataPath: "",
      jobWorkflow: {
        getJob: vi.fn(async () : Promise<any> => JOB),
        getJobResult
      },
      storageObjectProvider: null,
      loadNormalizedDocumentStoreRuntime: vi.fn(),
      getDiscoveryState: vi.fn(() : any => ({})),
      proxyApiRequest: vi.fn()
    });
    const response: any = responseRecorder();

    await handlers.handleGetJobResult({
      request: {},
      requestBody: Buffer.alloc(0),
      jobId: JOB.id,
      response,
      authSession: null
    });

    expect(response.statusCode).toBe(403);
    expect(response.payload).toEqual({ error: "任务不存在或不可访问。" });
    expect(getJobResult).not.toHaveBeenCalled();
  });
});
