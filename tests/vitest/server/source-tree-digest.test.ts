import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  currentRepositoryRevision,
  currentSourceTreeDigest
} from "../../../tools/server-scripts/lib/source-tree-digest.ts";

describe("current source tree digest", () : any => {
  it("changes for tracked and untracked source content while honoring projection exclusions", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-source-tree-digest-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
      spawnSync("git", ["add", "tracked.txt"], { cwd: root });
      const first: any = currentSourceTreeDigest(root);
      await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
      const trackedChange: any = currentSourceTreeDigest(root);
      expect(trackedChange).not.toBe(first);
      await fs.writeFile(path.join(root, "untracked.txt"), "three\n");
      expect(currentSourceTreeDigest(root)).not.toBe(trackedChange);
      expect(currentSourceTreeDigest(root, { exclude: ["untracked.txt"] })).toBe(trackedChange);
      await fs.rm(path.join(root, "tracked.txt"));
      expect(() : any => currentSourceTreeDigest(root)).not.toThrow();
      expect(currentSourceTreeDigest(root)).toBe(
        currentSourceTreeDigest(root, { exclude: ["tracked.txt"] })
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses verified package provenance when the deployed source has no Git metadata", async () : Promise<any> => {
    const savedWorker: any = process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER;
    const savedAcceptanceRoot: any = process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT;
    delete process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER;
    delete process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT;
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-packaged-source-digest-"));
    try {
      const content: any = Buffer.from("packaged source\n", "utf8");
      const entry: Record<string, any> = {
        path: "source.txt",
        bytes: content.byteLength,
        sha256: crypto.createHash("sha256").update(content).digest("hex")
      };
      const packageSha256: any = crypto.createHash("sha256")
        .update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
        .digest("hex");
      const sourceRevision: any = "a".repeat(40);
      await fs.writeFile(path.join(root, entry.path), content);
      await fs.writeFile(path.join(root, "meshrix-source-package-manifest.json"), JSON.stringify({
        schemaVersion: "v0.0.1:release:source-package-manifest-4",
        sourceRevision,
        sourceTreeDigest: `sha256:${packageSha256}`,
        packageSha256,
        files: [entry]
      }));

      expect(currentRepositoryRevision(root)).toBe(sourceRevision);
      expect(currentSourceTreeDigest(root)).toBe(`sha256:${packageSha256}`);
      expect(currentSourceTreeDigest(root, { exclude: [entry.path] })).toBe(
        `sha256:${crypto.createHash("sha256").digest("hex")}`
      );

      await fs.writeFile(path.join(root, entry.path), "tampered\n");
      expect(() : any => currentSourceTreeDigest(root)).toThrow("does not match its provenance");
    } finally {
      if (savedWorker === undefined) delete process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER;
      else process.env.MESHRIX_ACCEPTANCE_GENERATION_WORKER = savedWorker;
      if (savedAcceptanceRoot === undefined) delete process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT;
      else process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT = savedAcceptanceRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
