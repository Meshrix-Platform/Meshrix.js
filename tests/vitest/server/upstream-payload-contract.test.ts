import { describe, expect, it } from "vitest";
import {
  compilePayloadTransport,
  selectRequestRepresentationHeaders
} from "../../../packages/agents/src/upstream-gateway/payload-contract.ts";

describe("upstream payload representation contract", () : any => {
  it("requires an explicit bounded request representation and defaults response passthrough", () : any => {
    expect(() : any => compilePayloadTransport({})).toThrow("request representation mode is required");
    expect(compilePayloadTransport({
      payloadTransport: {
        request: { mode: "opaque_stream", maxBytes: 1024, mediaTypes: ["application/octet-stream"] }
      }
    }).response).toEqual({
      mode: "opaque_stream",
      maxBytes: 8 * 1024 * 1024,
      mediaTypes: ["*/*"],
      allowRanges: false
    });
    expect(() : any => compilePayloadTransport({
      payloadTransport: {
        request: { mode: "opaque_stream", maxBytes: 0, mediaTypes: ["application/octet-stream"] },
        response: { mode: "opaque_stream", maxBytes: 1, mediaTypes: ["application/octet-stream"] }
      }
    })).toThrow("positive bounded byte count");
  });

  it("rejects unsafe multipart mappings and strips authority or credential headers", () : any => {
    expect(() : any => compilePayloadTransport({
      payloadTransport: {
        request: {
          mode: "artifact_multipart",
          maxBytes: 1024,
          mediaTypes: ["multipart/form-data"],
          multipart: {
            maxParts: 1,
            artifactParts: [{ argument: "../file", partName: "file" }]
          }
        },
        response: { mode: "artifact", maxBytes: 1024, mediaTypes: ["application/pdf"] }
      }
    })).toThrow("argument is invalid");
    const selected: any = selectRequestRepresentationHeaders({
      authorization: "Bearer caller-secret",
      cookie: "private",
      host: "caller.invalid",
      "content-type": "application/octet-stream",
      digest: "sha-256=fixture"
    }, { mediaTypes: ["application/octet-stream"] });
    expect(selected).toEqual({
      "content-type": "application/octet-stream",
      digest: "sha-256=fixture"
    });
  });
});
