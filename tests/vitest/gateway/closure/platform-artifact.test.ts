import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { createPlatformMcpGateway } from "@meshrix/server-runtime/composition/gateway-composition";
import { createArtifactTransitProvider } from "../../../../packages/server-runtime/src/composition/artifact-transit-provider.ts";
import { installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";

describe("default platform binary/artifact boundary", () => {
  it("[GC-046 partial] keeps multipart bytes, declared headers and owner-bound range download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-artifact-"));
    const uploadPath = join(directory, "input.txt");
    const bytes = Buffer.from("synthetic-upload-byte-sequence", "utf8");
    const pdfBytes = Buffer.from("%PDF-1.7\nsynthetic-pdf-bytes", "utf8");
    await writeFile(uploadPath, bytes);
    const received: Buffer[] = [];
    const peer = createServer(async (request, response) => {
      for await (const chunk of request) received.push(Buffer.from(chunk));
      expect(request.headers["x-context-scope"]).toBe("synthetic");
      response.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=converted.pdf" });
      response.end(pdfBytes);
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("Synthetic peer has no TCP port.");
    let artifact: Awaited<ReturnType<typeof createArtifactTransitProvider>> | undefined;
    let registry: ReturnType<typeof createUpstreamGatewayRegistry> | undefined;
    let platform: ReturnType<typeof createPlatformMcpGateway> | undefined;
    try {
      artifact = await createArtifactTransitProvider({ userDataPath: directory, uploadSessionStore: { async resolveUploadSessionFiles() {
        return [{ originalFileName: "input.txt", mediaType: "text/plain", byteSize: bytes.length, sha256: "a".repeat(64), contentDigest: "a".repeat(64), envelopeDigest: "b".repeat(64), custodyRef: "custody:synthetic", resourceRef: "upload-resource:synthetic:0" }];
      } }, uploadCustodyReadPort: { async open() { return { stream: Readable.from([bytes]) }; } }, getListenUrl: () => "http://gateway.invalid" });
      registry = createUpstreamGatewayRegistry({ artifactTransitPort: artifact, claimProtectedSinkAttempt: async () => Object.freeze({ syntheticReceipt: true }) });
      installUpstreamRuntimeServices(registry, [{ serviceId: "format", serviceProtocol: "http", baseUrl: `http://127.0.0.1:${address.port}`, allowLocalNetwork: true, headers: { "x-context-scope": "synthetic" },
        operations: [{ operationKey: "convert", method: "POST", path: "/convert", risk: "safe_write", requiredScopes: ["gateway:write"], requestSchema: { type: "object", properties: { file: { type: "string" }, targetFormat: { type: "string" } }, required: ["file", "targetFormat"], additionalProperties: false }, payloadTransport: { request: { mode: "artifact_multipart", maxBytes: 1024 * 1024, mediaTypes: ["multipart/form-data"], multipart: { maxParts: 2, artifactParts: [{ argument: "file", partName: "file", required: true }], scalarFields: [{ argument: "targetFormat", partName: "target_format", required: true }] } }, response: { mode: "artifact", maxBytes: 1024 * 1024, mediaTypes: ["application/pdf"], allowRanges: true } } }]
      }]);
      platform = createPlatformMcpGateway({ upstreamGatewayRegistry: registry,
        toolSkillManagementProvider: { authorizeMcpClientRequest: async () => ({ ok: true, grant: { id: "grant", revision: "grant", subjectId: "owner", scopes: ["gateway:write"], dynamicCapabilities: ["cap:upstream:format:convert"] }, subject: { type: "tool-grant", subjectId: "owner", grantId: "grant", scopes: ["gateway:write"], dynamicCapabilities: ["cap:upstream:format:convert"] } }), listVisibleTools: async () => [] }
      });
      await platform.gateway.start();
      const send = async (method: string, params: Record<string, unknown> = {}) => platform!.adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: method, method, params } });
      const listed = await send("tools/list");
      const tool = (listed.body as { result: { tools: Array<{ name: string; _meta?: { serviceId?: string } }> } }).result.tools.find((entry) => entry._meta?.serviceId === "format");
      expect(tool, JSON.stringify(listed.body)).toBeDefined();
      const result = await send("tools/call", { name: tool!.name, arguments: { file: "upload:synthetic:0", targetFormat: "pdf" } });
      const artifactRef = (result.body as { result?: { structuredContent?: { artifact?: { reference?: string } } } }).result?.structuredContent?.artifact?.reference;
      expect(result.body).toMatchObject({ result: { structuredContent: { artifact: { reference: expect.stringMatching(/^artifact:/u) } } } });
      const multipart = Buffer.concat(received).toString("utf8");
      expect(multipart).toContain('name="target_format"');
      expect(multipart).toContain("pdf");
      expect(multipart).toContain(bytes.toString("utf8"));
      const full = await registry.openArtifactDownload({ artifactId: artifactRef!.slice("artifact:".length) }, { subjectId: "owner", scopes: ["gateway:write"] });
      const allChunks: Buffer[] = [];
      for await (const chunk of full.body) allChunks.push(Buffer.from(chunk));
      expect(Buffer.concat(allChunks)).toEqual(pdfBytes);
      const download = await registry.openArtifactDownload({ artifactId: artifactRef!.slice("artifact:".length), range: "bytes=1-4" }, { subjectId: "owner", scopes: ["gateway:write"] });
      const output: Buffer[] = [];
      for await (const chunk of download.body) output.push(Buffer.from(chunk));
      expect(download.status).toBe(206);
      expect(Buffer.concat(output)).toEqual(pdfBytes.subarray(1, 5));
      await expect(registry.openArtifactDownload({ artifactId: artifactRef!.slice("artifact:".length) }, { subjectId: "different", scopes: ["gateway:write"] })).rejects.toMatchObject({ status: 404 });
      expect((await readFile(uploadPath)).equals(bytes)).toBe(true);
    } finally {
      await platform?.close();
      await registry?.close();
      await artifact?.close();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
