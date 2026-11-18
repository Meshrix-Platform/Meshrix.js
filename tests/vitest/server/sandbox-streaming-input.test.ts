import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { sandboxDigest } from "../../../packages/foundation/src/execution-sandbox/contracts.ts";
import { materializeSandboxInputs } from "../../../packages/server-runtime/src/execution-sandbox/broker.ts";

describe("sandbox streaming input staging", () : any => {
  it("stages bounded chunks directly into an immutable input file", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-sandbox-stage-"));
    const content: any = Buffer.alloc(2 * 1024 * 1024, 7);
    const contentDigest: any = crypto.createHash("sha256").update(content).digest("hex");
    const inputDigest: any = sandboxDigest([{ path: "bundle.bin", digest: contentDigest }]);
    let largestChunk: any = 0;
    try {
      const staged: any = await materializeSandboxInputs({
        request: {
          inputs: [{ handle: "custody:fixture", digest: inputDigest, readOnly: true }],
          resources: { diskBytes: content.length }
        },
        inputRoot: root,
        resolveInput: async () : Promise<any> => ({
          digest: inputDigest,
          files: [{
            path: "bundle.bin",
            digest: contentDigest,
            async stageContent(sink?: any) : Promise<any> {
              for (let offset: any = 0; offset < content.length; offset += 32 * 1024) {
                const chunk: any = content.subarray(offset, offset + 32 * 1024);
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
      await fs.chmod(root, 0o700).catch(() : any => {});
      await fs.chmod(path.join(root, "0"), 0o700).catch(() : any => {});
      await fs.chmod(path.join(root, "0", "bundle.bin"), 0o600).catch(() : any => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes partial plaintext when the streamed digest is invalid", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-sandbox-stage-fail-"));
    try {
      await expect(materializeSandboxInputs({
        request: {
          inputs: [{ handle: "custody:fixture", digest: "a".repeat(64), readOnly: true }],
          resources: { diskBytes: 1024 }
        },
        inputRoot: root,
        resolveInput: async () : Promise<any> => ({
          files: [{
            path: "bundle.bin",
            digest: "b".repeat(64),
            stageContent: (sink?: any) : any => sink(Buffer.from("tampered", "utf8"))
          }]
        })
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
      const entries: any = await fs.readdir(path.join(root, "0"));
      expect(entries).toEqual([]);
    } finally {
      await fs.chmod(root, 0o700).catch(() : any => {});
      await fs.chmod(path.join(root, "0"), 0o700).catch(() : any => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces one disk budget across all declared inputs", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-sandbox-stage-global-bytes-"));
    const contents: any = new Map<any, any>([
      ["custody:first", Buffer.from("first", "utf8")],
      ["custody:second", Buffer.from("second", "utf8")]
    ]);
    const inputs: any = [...contents].map(([handle, content]: any[]) : any => {
      const fileDigest: any = crypto.createHash("sha256").update(content).digest("hex");
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
          inputs: inputs.map(({ handle, digest, readOnly }: Record<string, any>) : any => ({ handle, digest, readOnly })),
          resources: { diskBytes: 10, fileCount: 2, inodes: 2 }
        },
        inputRoot: root,
        resolveInput: async ({ handle }: Record<string, any>) : Promise<any> => {
          const input: any = inputs.find((entry?: any) : any => entry.handle === handle);
          return {
            digest: input.digest,
            files: [{ path: "bundle.bin", digest: input.fileDigest, content: contents.get(handle) }]
          };
        }
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
    } finally {
      await Promise.all(["0", "1"].map(async (index?: any) : Promise<any> => {
        await fs.chmod(path.join(root, index), 0o700).catch(() : any => {});
        await fs.chmod(path.join(root, index, "bundle.bin"), 0o600).catch(() : any => {});
      }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["fileCount", "inodes"])("enforces one %s budget across all declared inputs", async (limitName?: any) : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), `meshrix-sandbox-stage-global-${limitName}-`));
    const content: any = Buffer.from("bounded", "utf8");
    const fileDigest: any = crypto.createHash("sha256").update(content).digest("hex");
    const inputDigest: any = sandboxDigest([{ path: "bundle.bin", digest: fileDigest }]);
    try {
      await expect(materializeSandboxInputs({
        request: {
          inputs: ["custody:first", "custody:second"].map((handle?: any) : any => ({
            handle,
            digest: inputDigest,
            readOnly: true
          })),
          resources: { diskBytes: 1024, fileCount: 2, inodes: 2, [limitName]: 1 }
        },
        inputRoot: root,
        resolveInput: async () : Promise<any> => ({
          digest: inputDigest,
          files: [{ path: "bundle.bin", digest: fileDigest, content }]
        })
      })).rejects.toMatchObject({ code: "sandbox_input_integrity_failed" });
    } finally {
      await Promise.all(["0", "1"].map(async (index?: any) : Promise<any> => {
        await fs.chmod(path.join(root, index), 0o700).catch(() : any => {});
        await fs.chmod(path.join(root, index, "bundle.bin"), 0o600).catch(() : any => {});
      }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
