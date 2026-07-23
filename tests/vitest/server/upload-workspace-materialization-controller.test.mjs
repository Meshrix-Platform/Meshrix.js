import { describe, expect, it, vi } from "vitest";

import { createUploadSessionHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-upload-handlers.mjs";

function responseRecorder() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(payload) {
      this.payload = JSON.parse(payload);
    }
  };
}

function cancelHandler(provider) {
  return createUploadSessionHandlers({
    userDataPath: "<user-data>",
    checkpointUploadSessionStore: {},
    protocolEventBus: null,
    uploadWorkspaceMaterializationProvider: provider
  }).handleUploadWorkspaceMaterializationCancel;
}

describe("upload workspace materialization controller", () => {
  it("cancels an owned request through the materialization provider", async () => {
    const cancelled = {
      requestRef: "materialization:opaque",
      status: "cancelled",
      stage: "cancelled"
    };
    const provider = { cancel: vi.fn(async () => cancelled) };
    const response = responseRecorder();

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

  it("returns a non-disclosing response for an unavailable request", async () => {
    const provider = { cancel: vi.fn(async () => null) };
    const response = responseRecorder();

    await cancelHandler(provider)({
      requestRef: "materialization:unavailable",
      response,
      authSession: { user: { userId: "user-b" } }
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({ error: "Materialization request is unavailable." });
  });
});
