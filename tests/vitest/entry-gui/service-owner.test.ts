import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testProcesses: ChildProcess[] = [];
const orphanedWriterPids: number[] = [];
const serviceOwnerUrl = pathToFileURL(resolve(fileURLToPath(new URL("../../../apps/entry-gui/src/main/service-owner.ts", import.meta.url)))).href;
const childScript = fileURLToPath(new URL("./service-owner-child.mjs", import.meta.url));
const parentScript = fileURLToPath(new URL("./service-owner-parent.mjs", import.meta.url));

function launchOwner(dataDir: string, mode = "hold"): ChildProcess {
  const child = spawn(process.execPath, ["--experimental-strip-types", childScript, serviceOwnerUrl, dataDir, mode], {
    stdio: ["pipe", "pipe", "ignore"]
  });
  testProcesses.push(child);
  return child;
}

function firstLine(child: ChildProcess): Promise<string> {
  if (!child.stdout) return Promise.reject(new Error("The owner process has no stdout stream."));
  return new Promise((resolveLine, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      lines.close();
      reject(new Error(`The owner process exited before reporting its state (${code ?? signal ?? "unknown"}).`));
    };
    lines.once("line", (line) => {
      child.off("exit", onExit);
      lines.close();
      resolveLine(line);
    });
    child.once("exit", onExit);
  });
}

function lineReader(stream: Readable): { next(): Promise<string>; close(): void } {
  const reader = createInterface({ input: stream });
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  reader.on("line", (line) => {
    const resolveLine = waiting.shift();
    if (resolveLine) resolveLine(line);
    else queued.push(line);
  });
  return {
    next: () => queued.length > 0
      ? Promise.resolve(queued.shift()!)
      : new Promise((resolveLine) => waiting.push(resolveLine)),
    close: () => reader.close()
  };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!pidIsAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  while (pidIsAlive(pid)) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

afterEach(async () => {
  await Promise.all(testProcesses.splice(0).map(terminate));
  await Promise.all(orphanedWriterPids.splice(0).map(terminatePid));
});

describe("canonical Node service ownership", () => {
  it("allows only one simultaneous process owner for a profile", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "meshrix-entry-owner-race-"));
    let leftOutput: ReturnType<typeof lineReader> | null = null;
    let rightOutput: ReturnType<typeof lineReader> | null = null;
    try {
      const [left, right] = [launchOwner(dataDir, "race"), launchOwner(dataDir, "race")];
      expect(await Promise.all([firstLine(left), firstLine(right)])).toEqual(["ready", "ready"]);
      if (!left.stdin || !right.stdin) throw new Error("The race contenders have no start gate.");
      leftOutput = lineReader(left.stdout!);
      rightOutput = lineReader(right.stdout!);
      left.stdin.write("go\n");
      right.stdin.write("go\n");
      const [leftState, rightState] = await Promise.all([leftOutput.next(), rightOutput.next()]);
      expect([leftState, rightState].filter((state) => state === "acquired")).toHaveLength(1);
      expect([leftState, rightState].filter((state) => state === "rejected:entry_service_owner_active")).toHaveLength(1);
      await Promise.all([terminate(left), terminate(right)]);
    } finally {
      leftOutput?.close();
      rightOutput?.close();
      await Promise.all(testProcesses.map(terminate));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the OS lock when the Node writer is killed and admits one restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "meshrix-entry-owner-restart-"));
    try {
      const first = launchOwner(dataDir);
      expect(await firstLine(first)).toBe("acquired");
      await terminate(first);

      const restarted = launchOwner(dataDir);
      expect(await firstLine(restarted)).toBe("acquired");
      await terminate(restarted);
    } finally {
      await Promise.all(testProcesses.map(terminate));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retains profile ownership while shutdown is still draining and releases only on process exit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "meshrix-entry-owner-draining-"));
    let output: ReturnType<typeof lineReader> | null = null;
    try {
      const owner = launchOwner(dataDir, "delayed-shutdown");
      expect(await firstLine(owner)).toBe("acquired");
      if (!owner.stdout || !owner.stdin) throw new Error("The owner process has no lifecycle pipe.");
      output = lineReader(owner.stdout);
      owner.stdin.write("shutdown\n");
      expect(await output.next()).toBe("shutdown-started");

      const contender = launchOwner(dataDir);
      expect(await firstLine(contender)).toBe("rejected:entry_service_owner_active");
      await waitForExit(contender);

      owner.stdin.write("finish\n");
      expect(await output.next()).toBe("shutdown-finished");
      await waitForExit(owner);

      const restarted = launchOwner(dataDir);
      expect(await firstLine(restarted)).toBe("acquired");
      await terminate(restarted);
    } finally {
      output?.close();
      await Promise.all(testProcesses.map(terminate));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the lock with the Node writer after its GUI parent exits", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "meshrix-entry-owner-orphan-"));
    let output: ReturnType<typeof lineReader> | null = null;
    let parent: ChildProcess | null = null;
    let writerPid: number | null = null;
    try {
      parent = spawn(process.execPath, [parentScript, childScript, serviceOwnerUrl, dataDir], {
        stdio: ["pipe", "pipe", "ignore"]
      });
      testProcesses.push(parent);
      if (!parent.stdout) throw new Error("The simulated GUI parent has no stdout stream.");
      output = lineReader(parent.stdout);
      let hasAcquired = false;
      while (writerPid === null || !hasAcquired) {
        const line = await output.next();
        if (line.startsWith("parent:")) writerPid = Number(line.slice("parent:".length));
        else if (line === "acquired") hasAcquired = true;
      }
      if (writerPid === null || !Number.isSafeInteger(writerPid) || writerPid < 1) throw new Error("The simulated service writer did not report a valid process id.");
      orphanedWriterPids.push(writerPid);

      const parentExited = waitForExit(parent);
      parent.kill("SIGKILL");
      await parentExited;

      const contender = launchOwner(dataDir);
      expect(await firstLine(contender)).toBe("rejected:entry_service_owner_active");
      await waitForExit(contender);

      await terminatePid(writerPid);
      const restarted = launchOwner(dataDir);
      expect(await firstLine(restarted)).toBe("acquired");
      await terminate(restarted);
    } finally {
      output?.close();
      if (parent && parent.exitCode === null && parent.signalCode === null) await terminate(parent);
      if (writerPid !== null && Number.isSafeInteger(writerPid) && writerPid > 0) await terminatePid(writerPid);
      await Promise.all(testProcesses.map(terminate));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
