import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessHarness = vi.hoisted(() => ({
  fork: vi.fn()
}));

vi.mock("node:child_process", () => ({
  fork: childProcessHarness.fork
}));

import { createMaterializationDirectoryWorker } from "../../../packages/agents/src/agent-workspace/agent-workspace-materialization-file-worker.ts";

class SyntheticChild extends EventEmitter {
  connected = true;
  readonly killed: string[] = [];
  readonly sent: Array<Record<string, any>> = [];

  send(message: Record<string, any>, callback?: (error?: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill(signal = "SIGKILL"): boolean {
    this.killed.push(signal);
    return true;
  }

  reply(result: unknown): void {
    const request = this.sent.at(-1);
    this.emit("message", { id: request?.id, ok: true, result });
  }

  close(code: number | null = 0, signal: string | null = null): void {
    this.connected = false;
    this.emit("close", code, signal);
  }
}

afterEach(() : void => {
  vi.useRealTimers();
  childProcessHarness.fork.mockReset();
});

describe("agent workspace materialization file worker lifecycle", () : any => {
  it("keeps IPC ownership past the former deadline and settles only on response or child close", async () : Promise<any> => {
    vi.useFakeTimers();
    const child = new SyntheticChild();
    childProcessHarness.fork.mockReturnValue(child);
    const parentIdentity = {
      birthtimeNs: "1",
      dev: "1",
      ino: "1",
      mode: 0o700
    };
    const creating = createMaterializationDirectoryWorker({
      parentPath: "/synthetic-parent",
      parentIdentity,
      targetLeaf: "workspace.txt",
      tempLeaf: ".meshrix-materialization-abcdefghijklmnopqrst.tmp",
      contentDigest: "0".repeat(64),
      byteCount: 0
    });
    let creationSettled = false;
    void creating.then(
      () => { creationSettled = true; },
      () => { creationSettled = true; }
    );

    expect(child.sent[0]?.command).toBe("configure");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(creationSettled).toBe(false);
    expect(child.killed).toEqual([]);

    child.reply({ parentIdentity });
    const worker = await creating;
    const pendingReserve = worker.reserve();
    let reserveSettled = false;
    void pendingReserve.then(
      () => { reserveSettled = true; },
      () => { reserveSettled = true; }
    );
    expect(child.sent.at(-1)?.command).toBe("reserve");

    worker.terminate();
    expect(child.killed).toEqual(["SIGKILL"]);
    expect(reserveSettled).toBe(false);
    let closeSettled = false;
    const closing = worker.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    child.close(137, "SIGKILL");
    await expect(pendingReserve).rejects.toMatchObject({
      code: "materialization_file_worker_exited"
    });
    await closing;
    expect(reserveSettled).toBe(true);
    expect(closeSettled).toBe(true);
  });
});
