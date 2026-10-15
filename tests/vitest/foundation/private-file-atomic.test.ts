import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePrivateDir, writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";

const aclHarness = vi.hoisted(() => ({
  results: [] as Array<{ code: number | null; stdout?: string; stderr?: string; error?: Error }>,
  directoryContentsAtAcl: [] as string[][],
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { readdirSync } = await import("node:fs");
  const spawnMock = vi.fn((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    aclHarness.directoryContentsAtAcl.push(readdirSync(options.env.MESHRIX_PRIVATE_DIRECTORY!).sort());
    const result = aclHarness.results.shift() ?? { code: 0 };
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding: (encoding: string) => EventEmitter }; stderr: EventEmitter & { setEncoding: (encoding: string) => EventEmitter } };
    const stdout = Object.assign(new EventEmitter(), { setEncoding: (_encoding: string) => stdout });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: (_encoding: string) => stderr });
    child.stdout = stdout;
    child.stderr = stderr;
    queueMicrotask(() => {
      if (result.error) child.emit("error", result.error);
      if (result.stdout) stdout.emit("data", result.stdout);
      if (result.stderr) stderr.emit("data", result.stderr);
      child.emit("close", result.code, null);
    });
    return child;
  });
  return {
    spawn: spawnMock,
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
});

const spawnMock = vi.mocked(spawn);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let root = "";

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}

async function directoryEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

describe("writePrivateFileAtomic Windows ACL handling", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "meshrix-private-file-"));
    aclHarness.results = [];
    aclHarness.directoryContentsAtAcl = [];
    spawnMock.mockClear();
    vi.stubEnv("SystemRoot", "C:\\Windows");
    setPlatform("win32");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setPlatform(originalPlatform?.value as string);
    await rm(root, { recursive: true, force: true });
  });

  it("secures the directory before creating private files with one ACL operation and passes its path only as data", async () => {
    const directory = path.join(root, "private '$literal'");
    const filePath = path.join(directory, "state.json");
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "old state");
    aclHarness.results.push({ code: 0 });

    await expect(writePrivateFileAtomic(filePath, "new state")).resolves.toBe(filePath);

    expect(await readFile(filePath, "utf8")).toBe("new state");
    expect(await directoryEntries(directory)).toEqual(["state.json"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(aclHarness.directoryContentsAtAcl).toEqual([["state.json"]]);
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect((args || []).join(" ")).not.toContain(directory);
    expect(options?.env?.MESHRIX_PRIVATE_DIRECTORY).toBe(directory);
  });

  it("propagates a directory ACL failure before creating a temp file", async () => {
    const directory = path.join(root, "private");
    const filePath = path.join(directory, "state.json");
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "old state");
    aclHarness.results.push({ code: 5, stderr: "access denied" });

    await expect(writePrivateFileAtomic(filePath, "new state")).rejects.toThrow(/owner-only ACL.*access denied/u);

    expect(await readFile(filePath, "utf8")).toBe("old state");
    expect(await directoryEntries(directory)).toEqual(["state.json"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("propagates failure to start the ACL helper without creating or replacing data", async () => {
    const directory = path.join(root, "private");
    const filePath = path.join(directory, "state.json");
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "old state");
    aclHarness.results.push({ code: null, error: new Error("helper unavailable") });

    await expect(writePrivateFileAtomic(filePath, "new state")).rejects.toThrow(/owner-only ACL.*helper unavailable/u);

    expect(await readFile(filePath, "utf8")).toBe("old state");
    expect(await directoryEntries(directory)).toEqual(["state.json"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(aclHarness.directoryContentsAtAcl).toEqual([["state.json"]]);
  });

  it("propagates a Windows data-file sync failure instead of acknowledging an undurable replacement", async () => {
    const directory = path.join(root, "private");
    const filePath = path.join(directory, "state.json");
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, "old state");
    const open = fs.promises.open.bind(fs.promises);
    const syncError = Object.assign(new Error("data sync denied"), { code: "EACCES" });
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".tmp")) vi.spyOn(handle, "sync").mockRejectedValue(syncError);
      return handle;
    });

    await expect(writePrivateFileAtomic(filePath, "new state")).rejects.toBe(syncError);

    expect(await readFile(filePath, "utf8")).toBe("old state");
    expect(await directoryEntries(directory)).toEqual(["state.json"]);
  });

  it("reports a directory I/O failure after rename without deleting the completed file", async () => {
    const directory = path.join(root, "private");
    const filePath = path.join(directory, "state.json");
    const open = fs.promises.open.bind(fs.promises);
    const syncError = Object.assign(new Error("directory I/O failed"), { code: "EIO" });
    await mkdir(directory, { recursive: true });
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === directory) throw syncError;
      return open(...args);
    });

    await expect(writePrivateFileAtomic(filePath, "retained state")).rejects.toBe(syncError);

    expect(await readFile(filePath, "utf8")).toBe("retained state");
    expect(await directoryEntries(directory)).toEqual(["state.json"]);
  });
});


describe("private directory creation durability", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "meshrix-directory-sync-"));
    setPlatform(originalPlatform?.value as string);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("syncs a newly created ancestor chain before private bytes and skips it on existing-directory writes", async () => {
    const directory = path.join(root, "first", "second");
    const target = path.join(directory, "state.json");
    const open = fs.promises.open.bind(fs.promises);
    const trace: string[] = [];
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const targetPath = String(args[0]);
      if (args[1] === "r") {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          trace.push(targetPath);
          await sync();
        });
      } else if (targetPath.endsWith(".tmp")) trace.push("private-file");
      return handle;
    });

    await writePrivateFileAtomic(target, "first value");
    expect(trace).toEqual([directory, path.dirname(directory), root, "private-file", directory]);
    trace.length = 0;
    await writePrivateFileAtomic(target, "next value");
    expect(trace).toEqual(["private-file", directory]);
    expect(await readFile(target, "utf8")).toBe("next value");
  });

  it("retains a failed ancestor sync for retry before publishing any file", async () => {
    const directory = path.join(root, "first", "second");
    const target = path.join(directory, "state.json");
    const failure = Object.assign(new Error("ancestor sync failed"), { code: "EIO" });
    const open = fs.promises.open.bind(fs.promises);
    let fail = true;
    const trace: string[] = [];
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const targetPath = String(args[0]);
      trace.push(args[1] === "r" ? targetPath : "private-file");
      if (targetPath === root && fail) {
        fail = false;
        throw failure;
      }
      return open(...args);
    });

    await expect(writePrivateFileAtomic(target, "retained request")).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    trace.length = 0;
    await writePrivateFileAtomic(target, "retained request");
    expect(trace).toEqual([root, "private-file", directory]);
    expect(await readFile(target, "utf8")).toBe("retained request");
  });

  it("keeps a later child creation pending when an earlier parent sync completes", async () => {
    const first = path.join(root, "first", "state.json");
    const second = path.join(root, "second", "state.json");
    const open = fs.promises.open.bind(fs.promises);
    const chmod = fs.promises.chmod.bind(fs.promises);
    let parentEntered!: () => void;
    const syncingParent = new Promise<void>((resolve) => { parentEntered = resolve; });
    let releaseParent!: () => void;
    const heldParent = new Promise<void>((resolve) => { releaseParent = resolve; });
    let secondEntered!: () => void;
    const creatingSecond = new Promise<void>((resolve) => { secondEntered = resolve; });
    let releaseSecond!: () => void;
    const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let parentSyncs = 0;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === root) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          parentSyncs += 1;
          await sync();
          if (parentSyncs === 1) {
            parentEntered();
            await heldParent;
          }
        });
      }
      return handle;
    });
    vi.spyOn(fs.promises, "chmod").mockImplementation(async (...args) => {
      if (String(args[0]) === path.dirname(second)) {
        secondEntered();
        await heldSecond;
      }
      return chmod(...args);
    });

    const firstWrite = writePrivateFileAtomic(first, "first value");
    await syncingParent;
    const secondWrite = writePrivateFileAtomic(second, "second value");
    await creatingSecond;
    try {
      releaseParent();
      await firstWrite;
      expect(parentSyncs).toBe(1);
    } finally {
      releaseParent();
      releaseSecond();
    }
    await secondWrite;
    expect(parentSyncs).toBe(2);
    expect(await readFile(second, "utf8")).toBe("second value");
  });

  it("uses the same pending ancestor obligations in the synchronous entry point and preserves I/O failures", () => {
    const directory = path.join(root, "first", "second");
    const failure = Object.assign(new Error("synchronous ancestor failure"), { code: "EIO" });
    const open = fs.openSync.bind(fs);
    const trace: string[] = [];
    let fail = true;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const target = String(args[0]);
      trace.push(target);
      if (target === root && fail) {
        fail = false;
        throw failure;
      }
      return open(...args);
    });

    expect(() => ensurePrivateDir(directory)).toThrow(failure);
    expect(trace).toEqual([directory, path.dirname(directory), root]);
    trace.length = 0;
    ensurePrivateDir(directory);
    expect(trace).toEqual([root]);
    trace.length = 0;
    ensurePrivateDir(directory);
    expect(trace).toEqual([]);
  });
});
