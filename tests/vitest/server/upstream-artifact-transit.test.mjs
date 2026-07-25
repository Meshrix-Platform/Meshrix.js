import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { createArtifactTransitProvider } from "../../../packages/server-runtime/src/composition/artifact-transit-provider.mjs";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((close) => close()));
});

describe("owner-bound upstream artifact transit", () => {
  it("streams an uploaded artifact as multipart, stores the response, and serves a byte range", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-artifact-transit-test-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const uploadPath = path.join(root, "alice.txt");
    const uploadBytes = Buffer.from("Alice was beginning to get very tired.", "utf8");
    await fs.writeFile(uploadPath, uploadBytes);
    const observed = [];
    const peer = http.createServer(async (request, response) => {
      for await (const chunk of request) observed.push(Buffer.from(chunk));
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=alice.pdf"
      });
      response.end(Buffer.from("%PDF-1.7\nfixture-pdf-bytes", "utf8"));
    });
    await new Promise((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(() => new Promise((resolve) => peer.close(resolve)));
    const artifactPort = await createArtifactTransitProvider({
      userDataPath: root,
      uploadSessionStore: {
        async resolveUploadSessionFiles(_root, sessionId, { owner }) {
          expect(sessionId).toBe("session01");
          expect(owner.subjectId).toBe("owner");
          return [{
            stagedPath: uploadPath,
            originalFileName: "alice.txt",
            mediaType: "text/plain",
            byteSize: uploadBytes.byteLength,
            sha256: "a".repeat(64)
          }];
        }
      },
      getListenUrl: () => "http://gateway.invalid"
    });
    cleanup.push(() => artifactPort.close());
    const registry = createUpstreamGatewayRegistry({ artifactTransitPort: artifactPort });
    cleanup.push(() => registry.close());
    installUpstreamRuntimeServices(registry, [{
      serviceId: "format-convert",
      serviceProtocol: "http",
      baseUrl: `http://127.0.0.1:${peer.address().port}`,
      allowLocalNetwork: true,
      operations: [{
        operationKey: "convert",
        method: "POST",
        path: "/convert",
        risk: "safe_write",
        requiredScopes: ["gateway:write"],
        payloadTransport: {
          request: {
            mode: "artifact_multipart",
            maxBytes: 1024 * 1024,
            mediaTypes: ["multipart/form-data"],
            multipart: {
              maxParts: 2,
              artifactParts: [{ argument: "file", partName: "file", required: true }],
              scalarFields: [{ argument: "targetFormat", partName: "target_format", required: true }]
            }
          },
          response: {
            mode: "artifact",
            maxBytes: 1024 * 1024,
            mediaTypes: ["application/pdf"],
            allowRanges: true
          }
        }
      }]
    }]);
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    const result = await registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: "upload:session01:0", targetFormat: "pdf" }
    }, subject, { responseAdapter: "artifact" });
    const multipart = Buffer.concat(observed).toString("utf8");
    expect(multipart).toContain('name="target_format"');
    expect(multipart).toContain("pdf");
    expect(multipart).toContain('name="file"; filename="alice.txt"');
    expect(multipart).toContain(uploadBytes.toString("utf8"));
    expect(result.resource).toMatchObject({ name: "alice.pdf", mediaType: "application/pdf" });

    const download = await registry.openArtifactDownload({
      artifactId: result.resource.reference.slice("artifact:".length),
      range: "bytes=1-4"
    }, subject);
    const chunks = [];
    for await (const chunk of download.body) chunks.push(Buffer.from(chunk));
    expect(download).toMatchObject({ status: 206, headers: { "content-range": "bytes 1-4/26" } });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from("PDF-"));
    await expect(registry.openArtifactDownload({
      artifactId: result.resource.reference.slice("artifact:".length)
    }, { subjectId: "different-owner", scopes: ["gateway:write"] })).rejects.toMatchObject({ status: 404 });
  });
});
