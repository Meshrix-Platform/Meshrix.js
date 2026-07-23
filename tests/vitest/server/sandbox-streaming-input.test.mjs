import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sandboxDigest } from "../../../packages/foundation/src/execution-sandbox/contracts.mjs";
import { materializeSandboxInputs } from "../../../packages/server-runtime/src/execution-sandbox/broker.mjs";

describe("sandbox streaming input staging", () => {
  it("stages bounded chunks directly into an immutable input file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-sandbox-stage-"));
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    const contentDigest = crypto.createHash("sha256").update(content).digest("hex");
    const inputDigest = sandboxDigest([{ path: "bundle.bin", digest: contentDigest }]);
    let largestChunk = 0;
    try {
      const staged = await materializeSandboxInputs({
        request: {
          inputs: [{ handle: "custody:fixture", digest: inputDigest, readOnly: true }],
          resources: { diskBytes: content.length }
        },
        inputRoot: root,
        resolveInput: async () => ({
          digest: inputDigest,
          files: [{
            path: "bundle.bin",
            digest: contentDigest,
            async stageContent(sink) {
              for (let offset = 0; offset < content.length; offset += 32 * 1024) {
                const chunk = content.subarray(offset, offset + 32 * 1024);
                largestChunk = Math.max(largestChunk, chunk.length);
                await sink(chunk);
              }
            }
          }]
        })
      });
      expect(staged).toEqual([{ index: 0, digest: inputDigest, fileCount: 1, totalBytes: content.length }]);
      expect(largestChunk).toBe(32 * 1024);
      expect(await fs.readFile(path.join(root, "0", "bundle.bin"))).toEqual(content);
      expect((await fs.stat(path.join(root, "0", "bundle.bin"))).mode & 0o777).toBe(0o444);
    } finally {
      content.fill(0);
      await fs.chmod(root, 0o700).catch(() => {});
      await fs.chmod(path.join(root, "0"), 0o700).catch(() => {});
      await fs.chmod(path.join(root, "0", "bundle.bin"), 0o600).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes partial plaintext when the streamed digest is invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-sandbox-stage-fail-"));
    try {
      await expect(materializeSandboxInputs({
        request: {
          inputs: [{ handle: "custody:fixture", digest: "a".repeat(64), readOnly: true }],
          resources: { diskBytes: 1024 }
        },
        inputRoot: root,
        resolveInput: async () => ({
          files: [{
            path: "bundle.bin",
            digest: "b".repeat(64),
            stageContent: (sink) => sink(Buffer.from("tampered", "utf8"))
          }]
        })
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
      const entries = await fs.readdir(path.join(root, "0"));
      expect(entries).toEqual([]);
    } finally {
      await fs.chmod(root, 0o700).catch(() => {});
      await fs.chmod(path.join(root, "0"), 0o700).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces one disk budget across all declared inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-sandbox-stage-global-bytes-"));
    const contents = new Map([
      ["custody:first", Buffer.from("first", "utf8")],
      ["custody:second", Buffer.from("second", "utf8")]
    ]);
    const inputs = [...contents].map(([handle, content]) => {
      const fileDigest = crypto.createHash("sha256").update(content).digest("hex");
      return {
        handle,
        digest: sandboxDigest([{ path: "bundle.bin", digest: fileDigest }]),
        readOnly: true,
        fileDigest
      };
    });
    try {
      await expect(materializeSandboxInputs({
        request: {
          inputs: inputs.map(({ handle, digest, readOnly }) => ({ handle, digest, readOnly })),
          resources: { diskBytes: 10, fileCount: 2, inodes: 2 }
        },
        inputRoot: root,
        resolveInput: async ({ handle }) => {
          const input = inputs.find((entry) => entry.handle === handle);
          return {
            digest: input.digest,
            files: [{ path: "bundle.bin", digest: input.fileDigest, content: contents.get(handle) }]
          };
        }
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
    } finally {
      await Promise.all(["0", "1"].map(async (index) => {
        await fs.chmod(path.join(root, index), 0o700).catch(() => {});
        await fs.chmod(path.join(root, index, "bundle.bin"), 0o600).catch(() => {});
      }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["fileCount", "inodes"])("enforces one %s budget across all declared inputs", async (limitName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `lico-sandbox-stage-global-${limitName}-`));
    const content = Buffer.from("bounded", "utf8");
    const fileDigest = crypto.createHash("sha256").update(content).digest("hex");
    const inputDigest = sandboxDigest([{ path: "bundle.bin", digest: fileDigest }]);
    try {
      await expect(materializeSandboxInputs({
        request: {
          inputs: ["custody:first", "custody:second"].map((handle) => ({
            handle,
            digest: inputDigest,
            readOnly: true
          })),
          resources: { diskBytes: 1024, fileCount: 2, inodes: 2, [limitName]: 1 }
        },
        inputRoot: root,
        resolveInput: async () => ({
          digest: inputDigest,
          files: [{ path: "bundle.bin", digest: fileDigest, content }]
        })
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
    } finally {
      await Promise.all(["0", "1"].map(async (index) => {
        await fs.chmod(path.join(root, index), 0o700).catch(() => {});
        await fs.chmod(path.join(root, index, "bundle.bin"), 0o600).catch(() => {});
      }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
