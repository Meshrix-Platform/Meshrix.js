import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.mjs";
import {
  sanitizeMcpOutputValue,
  workspaceDirectoryFromWorkspaces
} from "../../../packages/capabilities/src/skills/tool-skill-management-provider-workspace-projection.mjs";
import {
  createArtifactTransitProvider,
  createWorkspaceArtifactFileStore
} from "../../../packages/server-runtime/src/composition/artifact-transit-provider.mjs";
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

describe("owner-bound workspace artifact transit", () => {
  async function setupWorkspaceTransit() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-transit-test-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const agentWorkspace = createAgentWorkspace({ userDataPath: root });
    cleanup.push(async () => agentWorkspace.close());
    const workspace = agentWorkspace.createWorkspace({ title: "Transit", ownerUserId: "owner" }).workspace;
    const uploadBytes = Buffer.from("Workspace TXT fixture bytes for conversion.", "utf8");
    const upload = await agentWorkspace.uploadWorkspaceFile({
      workspaceId: workspace.workspaceId,
      path: "notes/source.txt",
      contentBase64: uploadBytes.toString("base64"),
      actorUserId: "owner"
    });
    expect(upload.ok).toBe(true);
    const artifactPort = await createArtifactTransitProvider({
      userDataPath: root,
      uploadSessionStore: {
        async resolveUploadSessionFiles() {
          throw new Error("Upload sessions are unavailable in this fixture.");
        }
      },
      workspaceFileStore: createWorkspaceArtifactFileStore({ getAgentWorkspace: () => agentWorkspace }),
      getListenUrl: () => "http://gateway.invalid"
    });
    cleanup.push(() => artifactPort.close());
    return { workspace, uploadBytes, artifactPort };
  }

  async function setupMultipartPeer() {
    const observed = [];
    const peer = http.createServer(async (request, response) => {
      for await (const chunk of request) observed.push(Buffer.from(chunk));
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=converted.pdf"
      });
      response.end(Buffer.from("%PDF-1.7\nfixture-pdf-bytes", "utf8"));
    });
    await new Promise((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(() => new Promise((resolve) => peer.close(resolve)));
    return { observed, peer };
  }

  function installFormatConvertService(registry, port) {
    installUpstreamRuntimeServices(registry, [{
      serviceId: "format-convert",
      serviceProtocol: "http",
      baseUrl: `http://127.0.0.1:${port}`,
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
  }

  async function setupWorkspaceGateway() {
    const fixture = await setupWorkspaceTransit();
    const { observed, peer } = await setupMultipartPeer();
    const registry = createUpstreamGatewayRegistry({ artifactTransitPort: fixture.artifactPort });
    cleanup.push(() => registry.close());
    installFormatConvertService(registry, peer.address().port);
    return { ...fixture, observed, registry };
  }

  it("streams a workspace file as multipart through an owner-bound workspace reference", async () => {
    const { workspace, uploadBytes, observed, registry } = await setupWorkspaceGateway();
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    const result = await registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: `workspace:${workspace.workspaceId}:notes/source.txt`, targetFormat: "pdf" }
    }, subject, { responseAdapter: "artifact" });
    const multipart = Buffer.concat(observed).toString("utf8");
    expect(multipart).toContain('name="file"; filename="source.txt"');
    expect(multipart).toContain(uploadBytes.toString("utf8"));
    expect(multipart).toContain('name="target_format"');
    expect(result.resource).toMatchObject({ name: "converted.pdf", mediaType: "application/pdf" });
  });

  it("denies a workspace reference when the caller is not the workspace owner", async () => {
    const { workspace, observed, registry } = await setupWorkspaceGateway();
    await expect(registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: `workspace:${workspace.workspaceId}:notes/source.txt`, targetFormat: "pdf" }
    }, { subjectId: "intruder", scopes: ["gateway:write"] }, { responseAdapter: "artifact" }))
      .rejects.toMatchObject({ code: "artifact_owner_denied", status: 404 });
    expect(observed).toHaveLength(0);
  });

  it("rejects a workspace reference that escapes the workspace root", async () => {
    const { workspace, observed, registry } = await setupWorkspaceGateway();
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    await expect(registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: `workspace:${workspace.workspaceId}:../outside.txt`, targetFormat: "pdf" }
    }, subject, { responseAdapter: "artifact" }))
      .rejects.toMatchObject({ code: "artifact_reference_invalid", status: 400 });
    await expect(registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: `workspace:${workspace.workspaceId}:/etc/passwd`, targetFormat: "pdf" }
    }, subject, { responseAdapter: "artifact" }))
      .rejects.toMatchObject({ code: "artifact_reference_invalid", status: 400 });
    expect(observed).toHaveLength(0);
  });

  it("fails closed when the workspace file does not exist", async () => {
    const { workspace, observed, registry } = await setupWorkspaceGateway();
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    await expect(registry.forward({
      serviceId: "format-convert",
      operationKey: "convert",
      arguments: { file: `workspace:${workspace.workspaceId}:notes/missing.txt`, targetFormat: "pdf" }
    }, subject, { responseAdapter: "artifact" }))
      .rejects.toMatchObject({ code: "artifact_not_found", status: 404 });
    expect(observed).toHaveLength(0);
  });

  it("rejects malformed workspace references and resolves metadata owner-bound", async () => {
    const { workspace, uploadBytes, artifactPort } = await setupWorkspaceTransit();
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    await expect(artifactPort.resolve("workspace:", subject))
      .rejects.toMatchObject({ code: "artifact_reference_invalid", status: 400 });
    await expect(artifactPort.resolve(`workspace:${workspace.workspaceId}:`, subject))
      .rejects.toMatchObject({ code: "artifact_reference_invalid", status: 400 });
    const metadata = await artifactPort.resolve(
      `workspace:${workspace.workspaceId}:notes/source.txt`,
      subject,
      "upstream-request"
    );
    expect(metadata).toMatchObject({
      kind: "workspace",
      name: "source.txt",
      mediaType: "application/octet-stream",
      byteLength: uploadBytes.byteLength
    });
    await expect(artifactPort.resolve(
      `workspace:${workspace.workspaceId}:notes/source.txt`,
      { subjectId: "intruder", scopes: ["gateway:write"] },
      "upstream-request"
    )).rejects.toMatchObject({ code: "artifact_owner_denied", status: 404 });
  });

  it("keeps the internal workspace id obtainable through the MCP list/create projection", async () => {
    const { workspace, artifactPort } = await setupWorkspaceTransit();
    const subject = { subjectId: "owner", scopes: ["gateway:write"] };
    const directory = workspaceDirectoryFromWorkspaces([workspace]);

    const listOutput = sanitizeMcpOutputValue({ workspaces: [workspace] }, directory);
    expect(listOutput.workspaces).toHaveLength(1);
    expect(listOutput.workspaces[0].workspaceId).toBe(workspace.workspaceId);
    expect(listOutput.workspaces[0].workspaceRef).toBe("workspace-1");
    expect(listOutput.workspaces[0].workspaceName).toBe("Transit");

    const createOutput = sanitizeMcpOutputValue({ workspace }, directory);
    expect(createOutput.workspace.workspaceId).toBe(workspace.workspaceId);
    expect(createOutput.workspace.workspaceRef).toBe("workspace-1");

    const reference = `workspace:${listOutput.workspaces[0].workspaceId}:notes/source.txt`;
    await expect(artifactPort.resolve(reference, subject, "upstream-request"))
      .resolves.toMatchObject({ kind: "workspace", name: "source.txt" });
  });
});
