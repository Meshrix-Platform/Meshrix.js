import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertPathWithinRootSync } from "../../../packages/foundation/src/security/local-path-boundary.ts";
import {
  WORKSPACE_FILE_MAX_BYTES,
  normalizeWorkspaceRelativePath,
  sha256Buffer
} from "../../../packages/agents/src/agent-workspace/agent-workspace-support.ts";
import { createAgentWorkspaceLocalDirectoryMutations } from "../../../packages/agents/src/agent-workspace/agent-workspace-local-directory-mutations.ts";
import { createAgentWorkspaceLocalDirectorySnapshotApi } from "../../../packages/agents/src/agent-workspace/agent-workspace-local-directory-snapshot.ts";
import { workspaceIntegerLimit } from "../../../packages/agents/src/agent-workspace/agent-workspace-limits.ts";

const temporaryRoots: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fsp.rm(root, { recursive: true, force: true })));
});

async function createFixture() : Promise<any> {
  const root: any = await fsp.mkdtemp(path.join(os.tmpdir(), "meshrix-local-preimage-"));
  temporaryRoots.push(root);
  const mountRef: any = "mount-test";
  const workspace: Record<string, any> = { workspaceId: "workspace-test", ownerUserId: "owner-test" };
  const blocks: any = new Map<any, any>();
  const writes: any[] = [];
  const cas: Record<string, any> = {
    async putBlock(value?: any, options: Record<string, any> = {}) : Promise<any> {
      const bytes: any = Buffer.from(value);
      const payloadHash: any = crypto.createHash("sha256").update(bytes).digest("hex");
      const cid: any = `cid-${payloadHash}`;
      blocks.set(cid, Buffer.from(bytes));
      writes.push({ cid, metadata: options.metadata || {} });
      return { cid, payloadHash, byteLength: bytes.length };
    },
    async getBlock(cid?: any) : Promise<any> {
      const bytes: any = blocks.get(cid);
      return bytes ? { cid, bytes: Buffer.from(bytes) } : null;
    }
  };
  function resolveLocalDirectoryMountPath(input: Record<string, any> = {}, _workspace?: any, options: Record<string, any> = {}) : any {
    if (String(input.mountRef || "") !== mountRef) {
      throw new Error("mount missing");
    }
    const relativePath: any = normalizeWorkspaceRelativePath(input.path || "", { allowEmpty: false });
    const absolutePath: any = path.resolve(root, ...relativePath.split("/"));
    const bounded: any = assertPathWithinRootSync(root, absolutePath, {
      label: "test mount path",
      allowMissing: options.allowMissing !== false,
      requireExisting: options.requireExisting === true,
      allowDirectory: options.allowDirectory !== false,
      allowFile: options.allowFile !== false,
      allowSpecial: false
    });
    return {
      root,
      mount: { mountRef },
      relativePath,
      absolutePath: bounded.absolutePath,
      exists: bounded.exists,
      stat: bounded.stat
    };
  }
  const snapshotApi: any = createAgentWorkspaceLocalDirectorySnapshotApi({
    merkleState: { cas },
    resolveLocalDirectoryMountPath,
    mountMutationKey: (targetMountRef?: any, relativePath?: any) : any => `__mount__/${targetMountRef}/${relativePath}`
  });
  return { root, mountRef, workspace, cas, writes, resolveLocalDirectoryMountPath, snapshotApi };
}

describe("agent workspace local-directory preimages", () : any => {
  it("rejects invalid and unbounded workspace security limits", () : any => {
    expect(() : any => workspaceIntegerLimit("TEST_LIMIT", {
      defaultValue: 8,
      minimum: 1,
      maximum: 16,
      environment: { TEST_LIMIT: "not-a-number" }
    })).toThrow(/integer between/u);
    expect(() : any => workspaceIntegerLimit("TEST_LIMIT", {
      defaultValue: 8,
      minimum: 1,
      maximum: 16,
      environment: { TEST_LIMIT: "17" }
    })).toThrow(/integer between/u);
    expect(workspaceIntegerLimit("TEST_LIMIT", {
      defaultValue: 8,
      minimum: 1,
      maximum: 16,
      environment: {}
    })).toBe(8);
  });

  it("deduplicates concurrent CAS images, omits host paths, and rejects TOCTOU changes", async () : Promise<any> => {
    const fixture: any = await createFixture();
    await fsp.mkdir(path.join(fixture.root, "tree", "empty"), { recursive: true });
    await fsp.writeFile(path.join(fixture.root, "tree", "file.txt"), "before\n", "utf8");
    if (process.platform !== "win32") await fsp.chmod(path.join(fixture.root, "tree", "file.txt"), 0o750);

    const captures: any = await Promise.all([0, 1].map(() : any => fixture.snapshotApi.captureLocalDirectoryPreimage({
      workspace: fixture.workspace,
      input: { mountRef: fixture.mountRef },
      relativePaths: ["tree"],
      operationId: "test.concurrent.capture"
    })));

    const firstFile: any = captures[0].snapshot.entries.find((entry?: any) : any => entry.relativePath === "tree/file.txt");
    const secondFile: any = captures[1].snapshot.entries.find((entry?: any) : any => entry.relativePath === "tree/file.txt");
    expect(firstFile.contentCid).toBe(secondFile.contentCid);
    expect(captures[0].snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "tree/empty", type: "directory", state: "exists" })
    ]));
    expect(JSON.stringify(captures)).not.toContain(fixture.root);
    expect(JSON.stringify(fixture.writes)).not.toContain(fixture.root);
    expect(fixture.writes.every((write?: any) : any => !Object.hasOwn(write.metadata, "sourcePath"))).toBe(true);

    await fsp.writeFile(path.join(fixture.root, "tree", "file.txt"), "changed\n", "utf8");
    const writesBeforePreview: any = fixture.writes.length;
    const preview: any = await fixture.snapshotApi.restoreLocalDirectoryPreimage({
      workspace: fixture.workspace,
      snapshot: captures[0].snapshot,
      dryRun: true
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "write", scope: "localDir", path: "tree/file.txt" })
    ]));
    expect(fixture.writes).toHaveLength(writesBeforePreview);
    await expect(fixture.snapshotApi.validateLocalDirectoryPreimage({
      workspace: fixture.workspace,
      capture: captures[0]
    })).rejects.toMatchObject({ code: "local_directory_preimage_changed", status: 409 });
    const restored: any = await fixture.snapshotApi.restoreLocalDirectoryPreimage({
      workspace: fixture.workspace,
      snapshot: captures[0].snapshot,
      dryRun: false
    });
    expect(restored.ok).toBe(true);
    expect(await fsp.readFile(path.join(fixture.root, "tree", "file.txt"), "utf8")).toBe("before\n");
    if (process.platform !== "win32") {
      expect((await fsp.stat(path.join(fixture.root, "tree", "file.txt"))).mode & 0o777).toBe(0o750);
    }
  });

  it("rejects symlinks and files above the explicit preimage limit before mutation", async () : Promise<any> => {
    const fixture: any = await createFixture();
    if (process.platform !== "win32") {
      const outside: any = await fsp.mkdtemp(path.join(os.tmpdir(), "meshrix-local-preimage-outside-"));
      temporaryRoots.push(outside);
      await fsp.writeFile(path.join(fixture.root, "target.txt"), "target\n", "utf8");
      await fsp.symlink(path.join(fixture.root, "target.txt"), path.join(fixture.root, "linked.txt"));
      await fsp.symlink(outside, path.join(fixture.root, "linked-dir"));
      await expect(fixture.snapshotApi.captureLocalDirectoryPreimage({
        workspace: fixture.workspace,
        input: { mountRef: fixture.mountRef },
        relativePaths: ["linked.txt"],
        operationId: "test.symlink.capture"
      })).rejects.toThrow(/符号链接/u);
      expect(() : any => fixture.snapshotApi.writeFileAtomically(
        fixture.root,
        path.join(fixture.root, "linked-dir", "outside.txt"),
        Buffer.from("blocked\n")
      )).toThrow(/符号链接/u);
      await expect(fsp.access(path.join(outside, "outside.txt"))).rejects.toBeDefined();
      expect(await fsp.readFile(path.join(fixture.root, "target.txt"), "utf8")).toBe("target\n");
    }

    await fsp.writeFile(path.join(fixture.root, "oversized.dat"), Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1, 0x61));
    await expect(fixture.snapshotApi.captureLocalDirectoryPreimage({
      workspace: fixture.workspace,
      input: { mountRef: fixture.mountRef },
      relativePaths: ["oversized.dat"],
      operationId: "test.limit.capture"
    })).rejects.toMatchObject({ code: "local_directory_preimage_file_limit", status: 413 });
    expect((await fsp.stat(path.join(fixture.root, "oversized.dat"))).size).toBe(WORKSPACE_FILE_MAX_BYTES + 1);
  });

  it("rejects cross-workspace and duplicate-entry restore snapshots", async () : Promise<any> => {
    const fixture: any = await createFixture();
    await fsp.writeFile(path.join(fixture.root, "bound.txt"), "bound\n", "utf8");
    const capture: any = await fixture.snapshotApi.captureLocalDirectoryPreimage({
      workspace: fixture.workspace,
      input: { mountRef: fixture.mountRef },
      relativePaths: ["bound.txt"],
      operationId: "test.snapshot.binding"
    });
    await expect(fixture.snapshotApi.restoreLocalDirectoryPreimage({
      workspace: { ...fixture.workspace, workspaceId: "workspace-other" },
      snapshot: capture.snapshot,
      dryRun: true
    })).rejects.toMatchObject({ code: "local_directory_preimage_workspace_mismatch", status: 409 });
    const duplicateSnapshot: any = structuredClone(capture.snapshot);
    duplicateSnapshot.entries.push(structuredClone(duplicateSnapshot.entries[0]));
    duplicateSnapshot.entryCount = duplicateSnapshot.entries.length;
    await expect(fixture.snapshotApi.restoreLocalDirectoryPreimage({
      workspace: fixture.workspace,
      snapshot: duplicateSnapshot,
      dryRun: true
    })).rejects.toMatchObject({ code: "local_directory_preimage_entry_duplicate", status: 409 });
  });

  it("restores the host preimage and compensates state when checkpoint persistence fails", async () : Promise<any> => {
    const fixture: any = await createFixture();
    let commitCount: any = 0;
    const mutations: any = createAgentWorkspaceLocalDirectoryMutations({
      workspaceForStorage: () : any => ({ ok: true, workspace: fixture.workspace }),
      decodeWorkspaceFileContent: (input?: any) : any => Buffer.from(String(input.content || ""), "utf8"),
      updateWorkspaceTimeStmt: { run() : any {} },
      filePayloadMetadata: (file?: any) : any => ({
        type: file.type,
        sizeBytes: file.sizeBytes,
        contentSha256: file.contentSha256
      }),
      commitWorkspaceFileState: async () : Promise<any> => ({ commitId: `commit-${++commitCount}`, contentRefs: [] }),
      recordWorkspaceFileCheckpoint: async () : Promise<any> => {
        throw new Error("checkpoint fixture failure");
      },
      resolveLocalDirectoryMountPath: fixture.resolveLocalDirectoryMountPath,
      localDirectoryFileMetadataFromStat: ({ workspaceId, mount, relativePath, absolutePath, stat, includeHash }: Record<string, any>) : any => ({
        workspaceId,
        mountRef: mount.mountRef,
        relativePath,
        type: stat.isDirectory() ? "directory" : "file",
        sizeBytes: Number(stat.size || 0),
        contentSha256: includeHash && stat.isFile() ? sha256Buffer(fs.readFileSync(absolutePath)) : ""
      }),
      localDirectoryAccessReceipt: () : any => ({ receiptId: "receipt-test" }),
      publicLocalDirectoryMount: (mount?: any) : any => ({ mountRef: mount.mountRef }),
      archiveLocalDirectoryContent: async (content?: any, metadata?: any) : Promise<any> => {
        const block: any = await fixture.cas.putBlock(content, { metadata });
        return {
          rootCid: block.cid,
          contentRefs: [block.cid],
          metadata: { contentSha256: block.payloadHash, sizeBytes: block.byteLength }
        };
      },
      mountMutationKey: (mountRef?: any, relativePath?: any) : any => `__mount__/${mountRef}/${relativePath}`,
      captureLocalDirectoryPreimage: fixture.snapshotApi.captureLocalDirectoryPreimage,
      validateLocalDirectoryPreimage: fixture.snapshotApi.validateLocalDirectoryPreimage,
      rollbackLocalDirectoryMutation: fixture.snapshotApi.rollbackLocalDirectoryMutation,
      workspacePreimageSnapshot: fixture.snapshotApi.workspacePreimageSnapshot,
      writeFileAtomically: fixture.snapshotApi.writeFileAtomically
    });

    const result: any = await mutations.writeLocalDirectoryFile({
      workspaceId: fixture.workspace.workspaceId,
      mountRef: fixture.mountRef,
      path: "rollback/new.txt",
      content: "must roll back\n"
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("local_directory_mutation_failed");
    expect(commitCount).toBe(2);
    await expect(fsp.access(path.join(fixture.root, "rollback"))).rejects.toBeDefined();
    expect(JSON.stringify(result)).not.toContain(fixture.root);
  });
});
