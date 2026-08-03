import { describe, expect, it, vi } from "vitest";

import { createUploadSessionHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-upload-handlers.ts";

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

function cancelHandler(provider?: any) : any {
  return createUploadSessionHandlers({
    userDataPath: "<user-data>",
    checkpointUploadSessionStore: {},
    protocolEventBus: null,
    uploadWorkspaceMaterializationProvider: provider
  }).handleUploadWorkspaceMaterializationCancel;
}

describe("upload workspace materialization controller", () : any => {
  it("queries the bound upload store with the session id as its first argument", async () : Promise<any> => {
    const getUploadSession: any = vi.fn(async () : Promise<any> => null);
    const response: any = responseRecorder();
    const handler: any = createUploadSessionHandlers({
      checkpointUploadSessionStore: { getUploadSession },
      protocolEventBus: null,
      uploadWorkspaceMaterializationProvider: null
    }).handleGetUploadSession;

    await handler({
      sessionId: "session-safe",
      response,
      authSession: {
        user: {
          userId: "principal-safe",
          tenantId: "local",
          organizationNodeId: "organization:secondary"
        }
      }
    });

    expect(getUploadSession).toHaveBeenCalledOnce();
    expect(getUploadSession).toHaveBeenCalledWith(
      "session-safe",
      {
        owner: expect.objectContaining({
          subjectId: "principal-safe",
          tenantId: "local",
          organizationNodeId: "organization:secondary"
        })
      }
    );
    expect(response.statusCode).toBe(404);
  });

  it("cancels an owned request through the materialization provider", async () : Promise<any> => {
    const cancelled: Record<string, any> = {
      requestRef: "materialization:opaque",
      status: "cancelled",
      stage: "cancelled"
    };
    const provider: Record<string, any> = { cancel: vi.fn(async () : Promise<any> => cancelled) };
    const response: any = responseRecorder();

    await cancelHandler(provider)({
      requestRef: cancelled.requestRef,
      response,
      authSession: { user: { userId: "user-a" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual(cancelled);
    expect(provider.cancel).toHaveBeenCalledWith(cancelled.requestRef, {
      subject: expect.objectContaining({ subjectId: "user-a" })
    });
  });

  it("returns a non-disclosing response for an unavailable request", async () : Promise<any> => {
    const provider: Record<string, any> = { cancel: vi.fn(async () : Promise<any> => null) };
    const response: any = responseRecorder();

    await cancelHandler(provider)({
      requestRef: "materialization:unavailable",
      response,
      authSession: { user: { userId: "user-b" } }
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({ error: "Materialization request is unavailable." });
  });
});
