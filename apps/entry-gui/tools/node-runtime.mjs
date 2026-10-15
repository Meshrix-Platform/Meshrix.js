import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const NODE_RUNTIME_VERSION = "24.21.0";

const RUNTIME_TARGETS = Object.freeze({
  "aarch64-apple-darwin": Object.freeze({
    artifact: `node-v${NODE_RUNTIME_VERSION}-darwin-arm64.tar.xz`,
    downloadSha256: "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe",
    member: `node-v${NODE_RUNTIME_VERSION}-darwin-arm64/bin/node`,
    binarySha256: "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b",
    executable: "node"
  }),
  "x86_64-apple-darwin": Object.freeze({
    artifact: `node-v${NODE_RUNTIME_VERSION}-darwin-x64.tar.xz`,
    downloadSha256: "0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299",
    member: `node-v${NODE_RUNTIME_VERSION}-darwin-x64/bin/node`,
    binarySha256: "7abcf39bd37ab251015337ff75304d7555f0d8e88c6e0fbf04bce8ce34636f49",
    executable: "node"
  }),
  "aarch64-unknown-linux-gnu": Object.freeze({
    artifact: `node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.xz`,
    downloadSha256: "6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2",
    member: `node-v${NODE_RUNTIME_VERSION}-linux-arm64/bin/node`,
    binarySha256: "0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584",
    executable: "node"
  }),
  "x86_64-unknown-linux-gnu": Object.freeze({
    artifact: `node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.xz`,
    downloadSha256: "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6",
    member: `node-v${NODE_RUNTIME_VERSION}-linux-x64/bin/node`,
    binarySha256: "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c",
    executable: "node"
  }),
  "aarch64-pc-windows-msvc": Object.freeze({
    artifact: "win-arm64/node.exe",
    downloadSha256: "dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7",
    member: null,
    binarySha256: "dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7",
    executable: "node.exe"
  }),
  "x86_64-pc-windows-msvc": Object.freeze({
    artifact: "win-x64/node.exe",
    downloadSha256: "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    member: null,
    binarySha256: "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    executable: "node.exe"
  })
});

export function nodeRuntimeTarget(targetTriple) {
  const runtime = RUNTIME_TARGETS[targetTriple];
  if (!runtime) throw new Error(`No pinned Node.js ${NODE_RUNTIME_VERSION} sidecar supports target ${targetTriple}.`);
  return runtime;
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadPinnedArtifact({ url, destination, expectedSha256, fetchImpl }) {
  const response = await fetchImpl(url, { redirect: "error" });
  if (!response.ok || !response.body || new URL(response.url).origin !== "https://nodejs.org") {
    throw new Error("The pinned Node.js sidecar could not be downloaded from its official HTTPS source.");
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
  if (await fileSha256(destination) !== expectedSha256) {
    throw new Error("The downloaded Node.js sidecar failed its pinned SHA-256 check.");
  }
}

/** Download, verify and stage the exact upstream Node binary required by Tauri. */
export async function ensureBundledNodeRuntime({
  targetTriple,
  binariesDirectory,
  fetchImpl = fetch,
  tarExecutable = "tar"
}) {
  const runtime = nodeRuntimeTarget(targetTriple);
  const destination = join(binariesDirectory, `node-${targetTriple}${runtime.executable.endsWith(".exe") ? ".exe" : ""}`);
  if (existsSync(destination) && await fileSha256(destination) === runtime.binarySha256) {
    return Object.freeze({ version: NODE_RUNTIME_VERSION, reused: true });
  }

  mkdirSync(binariesDirectory, { recursive: true });
  const workDirectory = mkdtempSync(join(tmpdir(), "meshrix-entry-node-"));
  const stagingDirectory = mkdtempSync(join(binariesDirectory, ".node-stage-"));
  try {
    const artifactPath = join(workDirectory, basename(runtime.artifact));
    await downloadPinnedArtifact({
      url: `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${runtime.artifact}`,
      destination: artifactPath,
      expectedSha256: runtime.downloadSha256,
      fetchImpl
    });

    let binaryPath = artifactPath;
    if (runtime.member) {
      const extracted = spawnSync(tarExecutable, [
        "-xJf", artifactPath, "-C", workDirectory, "--strip-components=2", runtime.member
      ], { encoding: "utf8", windowsHide: true });
      if (extracted.status !== 0) throw new Error("The verified Node.js sidecar archive could not be extracted.");
      binaryPath = join(workDirectory, "node");
    }
    if (!existsSync(binaryPath) || await fileSha256(binaryPath) !== runtime.binarySha256) {
      throw new Error("The extracted Node.js sidecar failed its pinned SHA-256 check.");
    }

    const stagedBinary = join(stagingDirectory, runtime.executable);
    copyFileSync(binaryPath, stagedBinary);
    if (runtime.executable === "node") chmodSync(stagedBinary, 0o755);
    rmSync(destination, { force: true });
    renameSync(stagedBinary, destination);
    return Object.freeze({ version: NODE_RUNTIME_VERSION, reused: false });
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
