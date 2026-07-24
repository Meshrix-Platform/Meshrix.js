import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  currentRepositoryRevision,
  currentSourceTreeDigest
} from "../../../tools/server-scripts/lib/source-tree-digest.mjs";

describe("current source tree digest", () => {
  it("changes for tracked and untracked source content while honoring projection exclusions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-source-tree-digest-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
      spawnSync("git", ["add", "tracked.txt"], { cwd: root });
      const first = currentSourceTreeDigest(root);
      await fs.writeFile(path.join(root, "tracked.txt"), "two\n");
      const trackedChange = currentSourceTreeDigest(root);
      expect(trackedChange).not.toBe(first);
      await fs.writeFile(path.join(root, "untracked.txt"), "three\n");
      expect(currentSourceTreeDigest(root)).not.toBe(trackedChange);
      expect(currentSourceTreeDigest(root, { exclude: ["untracked.txt"] })).toBe(trackedChange);
      await fs.rm(path.join(root, "tracked.txt"));
      expect(() => currentSourceTreeDigest(root)).not.toThrow();
      expect(currentSourceTreeDigest(root)).toBe(
        currentSourceTreeDigest(root, { exclude: ["tracked.txt"] })
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses verified package provenance when the deployed source has no Git metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-packaged-source-digest-"));
    try {
      const content = Buffer.from("packaged source\n", "utf8");
      const entry = {
        path: "source.txt",
        bytes: content.byteLength,
        sha256: crypto.createHash("sha256").update(content).digest("hex")
      };
      const packageSha256 = crypto.createHash("sha256")
        .update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
        .digest("hex");
      const sourceRevision = "a".repeat(40);
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
      expect(() => currentSourceTreeDigest(root)).toThrow("does not match its provenance");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
