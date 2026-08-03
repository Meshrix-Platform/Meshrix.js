import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { CONTEXT_JOB_OPERATION_DEFINITIONS } from "../../../packages/contracts/src/operations/context-job-operation-definitions.ts";
import {
  admitJobCreatePayload
} from "../../../packages/protocols/http/controllers/jobs-controller-job-admission.ts";
import { createJobHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-job-handlers.ts";
import {
  normalizeCanonicalObjectSource
} from "../../../packages/server-runtime/src/jobs/job-pipeline.ts";

function createHandlers(overrides: Record<string, any> = {}) : any {
  return createJobHandlers({
    userDataPath: "private-test-root",
    checkpointUploadSessionStore: {
      buildCheckpointReceiptFromUploadSession: vi.fn()
    },
    jobWorkflow: {
      getJobByCheckpointId: vi.fn(),
      createJob: vi.fn()
    },
    deletionCoordinator: {},
    getDiscoveryState: () : any => ({
      mode: "forward",
      forwardBaseUrl: "https://forward.invalid",
      advertisedBaseUrl: "https://local.invalid",
      activeServiceUrl: "https://forward.invalid"
    }),
    proxyApiRequest: vi.fn(),
    protocolEventBus: null,
    resolveArchiveBatchIdentity: () : any => ({ archiveBatchId: "batch-safe" }),
    ...overrides
  });
}

function requestBody(value?: any) : any {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function canonicalObjectInput(overrides: Record<string, any> = {}) : any {
  return {
    rawObjectId: "object-safe",
    storageRelativePath: "job-uploads/objects/object-safe",
    rawObjectSha256: "b".repeat(64),
    rawObjectByteSize: 12,
    ...overrides
  };
}

describe("jobs.create upload-session-only frozen acceptance", () : any => {
  it("publishes one closed schema without a direct-file DTO", () : any => {
    const definition: any = CONTEXT_JOB_OPERATION_DEFINITIONS.find(
      (entry?: any) : any => entry.id === "jobs.create"
    );
    expect(definition?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false
    });
    expect(Object.keys(definition.inputSchema.properties).sort()).toEqual([
      "checkpoint",
      "forceNewVersion",
      "inputText",
      "parentJobId",
      "settings",
      "uploadSessionId",
      "versionGroupId",
      "workspaceId"
    ]);
  });

  it.each([
    {
      label: "missing",
      failure: Object.assign(new Error("missing"), { code: "upload_session_not_found" }),
      expectedCode: "upload_session_not_found"
    },
    {
      label: "incomplete",
      failure: Object.assign(new Error("incomplete"), { code: "upload_session_incomplete" }),
      expectedCode: "upload_session_incomplete"
    }
  ])("rejects a $label upload session before discovery or proxy effects", async ({
    failure,
    expectedCode
  }: Record<string, any>) : Promise<any> => {
    const getDiscoveryState: any = vi.fn();
    const proxyApiRequest: any = vi.fn();
    const getJobByCheckpointId: any = vi.fn();
    const createJob: any = vi.fn();
    const handlers: any = createHandlers({
      getDiscoveryState,
      proxyApiRequest,
      checkpointUploadSessionStore: {
        buildCheckpointReceiptFromUploadSession: vi.fn().mockRejectedValue(failure)
      },
      jobWorkflow: { getJobByCheckpointId, createJob }
    });

    await expect(handlers.handleCreateJob({
      request: {},
      requestBody: requestBody({ uploadSessionId: "session-safe" }),
      response: {},
      authSession: { user: { userId: "owner-safe" } }
    })).rejects.toMatchObject({ code: expectedCode });

    expect(getDiscoveryState).not.toHaveBeenCalled();
    expect(proxyApiRequest).not.toHaveBeenCalled();
    expect(getJobByCheckpointId).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects a malformed upload session identifier before any forward-mode effect", async () : Promise<any> => {
    const getDiscoveryState: any = vi.fn();
    const proxyApiRequest: any = vi.fn();
    const receiptLookup: any = vi.fn();
    const getJobByCheckpointId: any = vi.fn();
    const createJob: any = vi.fn();
    const handlers: any = createHandlers({
      getDiscoveryState,
      proxyApiRequest,
      checkpointUploadSessionStore: {
        buildCheckpointReceiptFromUploadSession: receiptLookup
      },
      jobWorkflow: { getJobByCheckpointId, createJob }
    });

    await expect(handlers.handleCreateJob({
      request: {},
      requestBody: requestBody({ uploadSessionId: "../session" }),
      response: {},
      authSession: { user: { userId: "owner-safe" } }
    })).rejects.toMatchObject({
      code: "job_create_upload_session_id_invalid"
    });

    expect(receiptLookup).not.toHaveBeenCalled();
    expect(getDiscoveryState).not.toHaveBeenCalled();
    expect(proxyApiRequest).not.toHaveBeenCalled();
    expect(getJobByCheckpointId).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("rejects a cross-owner upload session before discovery or proxy effects", async () : Promise<any> => {
    const getDiscoveryState: any = vi.fn();
    const proxyApiRequest: any = vi.fn();
    const getJobByCheckpointId: any = vi.fn();
    const createJob: any = vi.fn();
    const handlers: any = createHandlers({
      getDiscoveryState,
      proxyApiRequest,
      checkpointUploadSessionStore: {
        buildCheckpointReceiptFromUploadSession: vi.fn().mockResolvedValue({
          checkpointId: "checkpoint-safe",
          manifestSha256: "a".repeat(64),
          ownerSubjectId: "other-owner",
          fileCount: 1,
          files: []
        })
      },
      jobWorkflow: { getJobByCheckpointId, createJob }
    });

    await expect(handlers.handleCreateJob({
      request: {},
      requestBody: requestBody({ uploadSessionId: "session-safe" }),
      response: {},
      authSession: { user: { userId: "owner-safe" } }
    })).rejects.toMatchObject({
      code: "job_create_upload_session_owner_mismatch"
    });

    expect(getDiscoveryState).not.toHaveBeenCalled();
    expect(proxyApiRequest).not.toHaveBeenCalled();
    expect(getJobByCheckpointId).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("keeps a completed owner-bound upload session local in forward mode", async () : Promise<any> => {
    const getDiscoveryState: any = vi.fn().mockReturnValue({
      mode: "forward",
      forwardBaseUrl: "https://forward.invalid",
      advertisedBaseUrl: "https://local.invalid",
      activeServiceUrl: "https://forward.invalid"
    });
    const proxyApiRequest: any = vi.fn();
    const checkpointReceipt: Record<string, any> = {
      checkpointId: "checkpoint-safe",
      manifestSha256: "a".repeat(64),
      ownerSubjectId: "owner-safe",
      fileCount: 1,
      files: [{
        name: "opaque",
        relativePath: "opaque",
        sha256: "b".repeat(64),
        byteSize: 12
      }]
    };
    const receiptLookup: any = vi.fn().mockResolvedValue(checkpointReceipt);
    const getJobByCheckpointId: any = vi.fn().mockResolvedValue(null);
    const createJob: any = vi.fn().mockResolvedValue({
      id: "job-safe",
      status: "queued"
    });
    const handlers: any = createHandlers({
      getDiscoveryState,
      proxyApiRequest,
      checkpointUploadSessionStore: {
        buildCheckpointReceiptFromUploadSession: receiptLookup
      },
      jobWorkflow: { getJobByCheckpointId, createJob }
    });
    const response: Record<string, any> = { writeHead: vi.fn(), end: vi.fn() };

    await handlers.handleCreateJob({
      request: {},
      requestBody: requestBody({ uploadSessionId: "session-safe" }),
      response,
      authSession: { user: { userId: "owner-safe" } }
    });

    expect(receiptLookup).toHaveBeenCalledTimes(1);
    expect(receiptLookup).toHaveBeenCalledWith(
      "session-safe",
      {
        owner: {
          present: true,
          subjectId: "owner-safe",
          userId: "owner-safe",
          username: "",
          roleId: "",
          tenantId: "",
          organizationNodeId: "",
          scopes: [],
          allowedWorkspaceIds: [],
          allowedJobIds: [],
          canAccessAll: false
        }
      }
    );
    expect(getDiscoveryState).toHaveBeenCalledTimes(1);
    expect(proxyApiRequest).not.toHaveBeenCalled();
    expect(getJobByCheckpointId).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob.mock.calls[0][0].checkpointReceipt).toBe(checkpointReceipt);
    expect(response.writeHead).toHaveBeenCalledWith(
      202,
      expect.objectContaining({
        "Content-Type": "application/json; charset=utf-8"
      })
    );
  });

  it("rejects an unknown property before forward-mode effects", async () : Promise<any> => {
    const proxyApiRequest: any = vi.fn();
    const checkpointLookup: any = vi.fn();
    const createJob: any = vi.fn();
    const handlers: any = createHandlers({
      proxyApiRequest,
      checkpointUploadSessionStore: {
        buildCheckpointReceiptFromUploadSession: checkpointLookup
      },
      jobWorkflow: {
        getJobByCheckpointId: vi.fn(),
        createJob
      }
    });

    await expect(handlers.handleCreateJob({
      request: {},
      requestBody: requestBody({
        inputText: "safe",
        unexpectedBinaryPayload: { encoded: "opaque" }
      }),
      response: {},
      authSession: {}
    })).rejects.toMatchObject({ code: "job_create_payload_unknown_field" });

    expect(proxyApiRequest).not.toHaveBeenCalled();
    expect(checkpointLookup).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("normalizes bounded direct text without representing it as a file", () : any => {
    const first: any = admitJobCreatePayload({
      inputText: "bounded direct text",
      checkpoint: { checkpointId: "client-checkpoint", mode: "direct-text" },
      workspaceId: "workspace-safe",
      settings: {}
    });
    const second: any = admitJobCreatePayload({
      settings: {},
      workspaceId: "workspace-safe",
      checkpoint: { mode: "direct-text", checkpointId: "client-checkpoint" },
      inputText: "bounded direct text"
    });
    const changed: any = admitJobCreatePayload({
      inputText: "different bounded direct text",
      checkpoint: { checkpointId: "client-checkpoint", mode: "direct-text" },
      workspaceId: "workspace-safe",
      settings: {}
    });

    expect(first.kind).toBe("direct-text");
    expect(first.receipt).toEqual(second.receipt);
    expect(first.receipt.contentHash).toBe(
      createHash("sha256").update("bounded direct text", "utf8").digest("hex")
    );
    expect(changed.receipt.contentHash).not.toBe(first.receipt.contentHash);
    expect(changed.receipt.checkpointId).not.toBe(first.receipt.checkpointId);
    expect(changed.receipt.archiveBatchId).not.toBe(
      first.receipt.archiveBatchId
    );
    expect(first.receipt).toMatchObject({
      fileCount: 0,
      files: []
    });
    expect(first.payload).toEqual(expect.objectContaining({
      inputText: "bounded direct text",
      workspaceId: "workspace-safe"
    }));
  });

  it("requires one unambiguous canonical input", () : any => {
    expect(() : any => admitJobCreatePayload({})).toThrowError(
      expect.objectContaining({ code: "job_create_input_required" })
    );
    expect(() : any => admitJobCreatePayload({
      uploadSessionId: "session-safe",
      inputText: "ambiguous"
    })).toThrowError(expect.objectContaining({
      code: "job_create_input_ambiguous"
    }));
    expect(() : any => admitJobCreatePayload({
      inputText: "x".repeat(1024 * 1024 + 1)
    })).toThrowError(expect.objectContaining({
      code: "job_create_direct_text_too_large"
    }));
  });

  it("normalizes reparse through an opaque canonical object reference", () : any => {
    const source: any = normalizeCanonicalObjectSource({
      ...canonicalObjectInput(),
      originalFileName: "document.bin",
      mediaType: "application/octet-stream"
    });

    expect(source).toEqual({
      kind: "canonical-object",
      objectRef: {
        objectId: "object-safe",
        storageRelativePath: "job-uploads/objects/object-safe",
        sha256: "b".repeat(64),
        byteSize: 12
      },
      originalFileName: "document.bin",
      mediaType: "application/octet-stream",
      sourceMetadata: {}
    });
    expect(JSON.stringify(source)).not.toContain("/private/");

    expect(() : any => normalizeCanonicalObjectSource({
      ...canonicalObjectInput(),
      storageRelativePath: "/private/host/object",
    })).toThrowError(expect.objectContaining({
      code: "canonical_reparse_object_ref_invalid"
    }));
  });

  it.each([
    {
      label: "a traversal path",
      input: canonicalObjectInput({
        storageRelativePath: "job-uploads/objects/../outside"
      })
    },
    {
      label: "missing object identity",
      input: {
        storageRelativePath: "job-uploads/objects/object-safe",
        rawObjectSha256: "b".repeat(64),
        rawObjectByteSize: 12
      }
    },
    {
      label: "a malformed digest",
      input: canonicalObjectInput({
        rawObjectSha256: "not-a-sha256"
      })
    },
    {
      label: "an invalid byte size",
      input: canonicalObjectInput({
        rawObjectByteSize: -1
      })
    },
    {
      label: "an unexpected property",
      input: canonicalObjectInput({
        unexpectedProperty: "opaque"
      })
    }
  ])("rejects $label in a canonical reparse reference", ({ input }: Record<string, any>) : any => {
    expect(() : any => normalizeCanonicalObjectSource(input)).toThrowError(
      expect.objectContaining({
        code: "canonical_reparse_object_ref_invalid"
      })
    );
  });
});
