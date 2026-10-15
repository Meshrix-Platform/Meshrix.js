import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runUpload } from "../../../apps/server/bin/lib/meshrix-cli-upload.ts";

describe("Meshrix CLI upload request count", () => {
  it("uses the authoritative chunk response instead of rereading the completed session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meshrix-cli-upload-"));
    const inputPath = path.join(directory, "fixture.bin");
    const outputPath = path.join(directory, "job.json");
    const content = Buffer.from("synthetic upload payload");
    const sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(inputPath, content);

    let sessionReads = 0;
    let chunkWrites = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const sendJson = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };

      if (request.method === "POST" && request.url === "/api/upload-sessions") {
        const manifest = JSON.parse(body.toString("utf8"));
        sendJson({
          sessionId: "session-fixture",
          files: manifest.files.map((file: Record<string, unknown>, index: number) => ({
            index,
            sha256: file.sha256,
            byteSize: file.byteSize,
            completed: false,
            receivedBytes: 0
          }))
        });
        return;
      }
      if (request.method === "PUT" && request.url === "/api/upload-sessions/session-fixture/files/0?offset=0") {
        chunkWrites += 1;
        expect(body.equals(content)).toBe(true);
        sendJson({
          sessionId: "session-fixture",
          files: [{ index: 0, sha256, byteSize: content.length, completed: true, receivedBytes: content.length }]
        });
        return;
      }
      if (request.method === "GET" && request.url === "/api/upload-sessions/session-fixture") {
        sessionReads += 1;
        sendJson({
          sessionId: "session-fixture",
          files: [{ index: 0, sha256, byteSize: content.length, completed: true, receivedBytes: content.length }]
        });
        return;
      }
      if (request.method === "POST" && request.url === "/api/jobs") {
        sendJson({ id: "job-fixture", status: "queued" });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_listener_address_missing");

    try {
      await runUpload({
        file: [inputPath],
        path: [],
        input: [],
        "server-url": `http://127.0.0.1:${address.port}`,
        "chunk-size": 64 * 1024,
        output: outputPath
      });
      expect(chunkWrites).toBe(1);
      expect(sessionReads).toBe(0);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ id: "job-fixture" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
