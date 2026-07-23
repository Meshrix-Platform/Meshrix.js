import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SERVER_URL, readJsonInput, requestJson, writeResponse } from "./lico-cli-common.mjs";

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

async function walkInput(inputPath, rootPath = inputPath) {
  const stats = await fsp.stat(inputPath);
  if (stats.isDirectory()) {
    const names = await fsp.readdir(inputPath);
    const nested = [];
    for (const name of names) {
      if (name === ".DS_Store") {
        continue;
      }
      nested.push(...(await walkInput(path.join(inputPath, name), rootPath)));
    }
    return nested;
  }

  if (!stats.isFile()) {
    return [];
  }

  return [
    {
      absolutePath: path.resolve(inputPath),
      relativePath: path.relative(path.dirname(rootPath), inputPath).replace(/\\/g, "/"),
      byteSize: stats.size
    }
  ];
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function digestManifest(files) {
  return createHash("sha256")
    .update(JSON.stringify(files.map((file) => [file.relativePath, file.sha256, file.byteSize])))
    .digest("hex");
}

async function collectUploadFiles(args) {
  const inputs = [...args.file, ...args.path, ...args.input];
  if (inputs.length === 0) {
    throw new Error("请使用 --file、--path 或 --input 指定上传内容。");
  }

  const files = [];
  for (const input of inputs) {
    files.push(...(await walkInput(path.resolve(String(input)))));
  }
  if (files.length === 0) {
    throw new Error("没有找到可上传的文件。");
  }

  for (const file of files) {
    file.name = path.basename(file.relativePath);
    file.mediaType = "application/octet-stream";
    file.sha256 = await sha256File(file.absolutePath);
  }

  return files;
}

async function uploadFileChunks({ serverUrl, sessionId, file, fileIndex, chunkSize, receivedBytes }) {
  let offset = Number(receivedBytes || 0);
  const handle = await fsp.open(file.absolutePath, "r");
  try {
    while (offset < file.byteSize) {
      const length = Math.min(chunkSize, file.byteSize - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const session = await requestJson({
        serverUrl,
        method: "PUT",
        apiPath: `/api/upload-sessions/${encodeURIComponent(sessionId)}/files/${fileIndex}?offset=${offset}`,
        body: buffer,
        okStatuses: [409],
        headers: {
          "content-type": "application/octet-stream"
        }
      });
      if (session?.code) {
        if (
          session.code !== "offset_mismatch" &&
          session.code !== "chunk_too_large" &&
          session.code !== "sha256_mismatch"
        ) {
          throw new Error(session.error || `上传分块失败：${session.code}`);
        }
        const remoteSession = session.session || {};
        const remoteFile = (remoteSession.files || []).find((item) => item.index === fileIndex);
        offset = Number(session.expectedOffset ?? remoteFile?.receivedBytes ?? 0);
        process.stderr.write(
          `realigned ${file.relativePath}: ${session.code}, offset ${offset}\n`
        );
        continue;
      }
      const remoteFile = session.files.find((item) => item.index === fileIndex);
      offset = Number(remoteFile?.receivedBytes || offset + length);
      process.stderr.write(`uploaded ${file.relativePath}: ${offset}/${file.byteSize}\n`);
    }
  } finally {
    await handle.close();
  }
}

async function waitForJob({ serverUrl, jobId }) {
  let current = await requestJson({
    serverUrl,
    method: "GET",
    apiPath: `/api/jobs/${encodeURIComponent(jobId)}`
  });
  while (!["completed", "failed", "cancelled", "deleted"].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    current = await requestJson({
      serverUrl,
      method: "GET",
      apiPath: `/api/jobs/${encodeURIComponent(jobId)}`
    });
    process.stderr.write(`${current.status} ${current.progressPercent || 0}% ${current.stage || ""}\n`);
  }
  if (current.status !== "completed") {
    throw new Error(current.error || `Job ended with status ${current.status}`);
  }
  return current;
}

export async function runUpload(args) {
  const serverUrl = args["server-url"] || DEFAULT_SERVER_URL;
  const chunkSize = Math.max(64 * 1024, Number(args["chunk-size"] || DEFAULT_CHUNK_SIZE));
  const files = await collectUploadFiles(args);
  const manifestDigest = digestManifest(files);
  const checkpointId = String(args["checkpoint-id"] || `cli-${manifestDigest.slice(0, 24)}`);
  const settings = args.settings ? await readJsonInput(args.settings, "--settings") : {};

  let session = await requestJson({
    serverUrl,
    method: "POST",
    apiPath: "/api/upload-sessions",
    body: {
      checkpoint: { checkpointId, mode: "lico-cli" },
      manifest: { manifestDigest, inputDigest: manifestDigest },
      files: files.map(({ name, relativePath, mediaType, sha256, byteSize }) => ({
        name,
        relativePath,
        mediaType,
        sha256,
        byteSize
      }))
    }
  });

  for (const [fallbackIndex, file] of files.entries()) {
    const remote = session.files.find(
      (item) =>
        item.index === fallbackIndex &&
        item.sha256 === file.sha256 &&
        Number(item.byteSize || 0) === Number(file.byteSize || 0)
    );
    if (!remote) {
      throw new Error(`上传会话缺少文件：${file.relativePath}`);
    }
    if (!remote.completed) {
      await uploadFileChunks({
        serverUrl,
        sessionId: session.sessionId,
        file,
        fileIndex: remote.index,
        chunkSize,
        receivedBytes: remote.receivedBytes
      });
      session = await requestJson({
        serverUrl,
        method: "GET",
        apiPath: `/api/upload-sessions/${encodeURIComponent(session.sessionId)}`
      });
    }
  }

  const job = await requestJson({
    serverUrl,
    method: "POST",
    apiPath: "/api/jobs",
    body: {
      checkpoint: { checkpointId, mode: "lico-cli" },
      uploadSessionId: session.sessionId,
      uploadedFiles: [],
      settings
    }
  });

  if (!args.wait) {
    await writeResponse({ args, result: job });
    return;
  }

  await waitForJob({ serverUrl, jobId: job.id });
  const result = await requestJson({
    serverUrl,
    method: "GET",
    apiPath: `/api/jobs/${encodeURIComponent(job.id)}/result`
  });

  if (args["output-result"]) {
    const outputPath = path.resolve(String(args["output-result"]));
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    process.stderr.write(`result: ${outputPath}\n`);
  }

  await writeResponse({ args, result });
}
