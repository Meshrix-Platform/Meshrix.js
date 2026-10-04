import { beforeEach, describe, expect, it, vi } from "vitest";

const workerHarness = vi.hoisted(() => {
  class ControlledWorker {
    static readonly instances: ControlledWorker[] = [];
    readonly #listeners = new Map<string, Array<(...args: any[]) => void>>();
    readonly messages: Array<{ readonly type: string; readonly jobId: number }> = [];
    failPostMessage: Error | undefined;
    terminated = false;

    constructor() { ControlledWorker.instances.push(this); }
    on(event: string, listener: (...args: any[]) => void): this {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
      return this;
    }
    emit(event: string, ...args: any[]): void {
      for (const listener of this.#listeners.get(event) ?? []) listener(...args);
    }
    removeAllListeners(event?: string): this {
      if (event === undefined) this.#listeners.clear();
      else this.#listeners.delete(event);
      return this;
    }
    listenerCount(): number { return [...this.#listeners.values()].reduce((count, listeners) => count + listeners.length, 0); }
    sendReady(): void { this.emit("message", { type: "ready" }); }
    respond(jobId: number, result: Readonly<Record<string, unknown>> = { valid: true, errors: [] }): void {
      this.emit("message", { type: "result", jobId, result });
    }
    fail(error = new Error("controlled worker failure")): void { this.emit("error", error); }
    exit(code: number): void { this.emit("exit", code); }
    postMessage(message: { readonly type: string; readonly jobId: number }): void {
      if (this.failPostMessage) throw this.failPostMessage;
      this.messages.push(message);
    }
    terminate(): Promise<number> { this.terminated = true; return Promise.resolve(1); }
    ref(): this { return this; }
    unref(): this { return this; }
    static reset(): void { this.instances.length = 0; }
  }
  return { ControlledWorker };
});

vi.mock("node:worker_threads", () => ({ Worker: workerHarness.ControlledWorker }));

import { createIsolatedSchemaValidator } from "@meshrix/gateway/schema";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

const schema = { type: "object", required: ["ok"] };

function workerAt(index: number): InstanceType<typeof workerHarness.ControlledWorker> {
  const worker = workerHarness.ControlledWorker.instances[index];
  if (!worker) throw new Error(`Expected controlled worker ${index}.`);
  return worker;
}

beforeEach(() => workerHarness.ControlledWorker.reset());

describe("isolated schema worker lifecycle", () => {
  it("excludes delayed trusted bootstrap from the unchanged execution deadline", async () => {
    vi.useFakeTimers();
    const validator = createIsolatedSchemaValidator();
    try {
      const pending = validator.preflight(schema);
      const worker = workerAt(0);
      expect(validator.stats()).toMatchObject({ workers: 1, active: 1, queued: 0, deadlineTimers: 0 });

      await vi.advanceTimersByTimeAsync(751);
      expect(validator.stats().deadlineTimers).toBe(0);
      worker.sendReady();
      expect(worker.messages).toHaveLength(1);
      expect(worker.messages[0]).toMatchObject({ type: "validate" });
      expect(validator.stats().deadlineTimers).toBe(1);
      worker.respond(worker.messages[0].jobId);
      await expect(pending).resolves.toBeUndefined();

      const execution = validator.preflight(schema).then(() => undefined, (error: unknown) => error);
      expect(worker.messages).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(750);
      expect(await execution).toMatchObject({ code: "schema_execution_timeout" });
      expect(worker.terminated).toBe(true);
    } finally {
      await validator.close();
      vi.useRealTimers();
    }
  });

  it("reuses one registry-port validator across valid calls and closes its pool", async () => {
    const port = createGatewaySchemaPort();
    const first = port.validate({ schema, value: { ok: true } });
    const worker = workerAt(0);
    worker.sendReady();
    worker.respond(worker.messages[0].jobId);
    await expect(first).resolves.toEqual({ ok: true });

    const second = port.validate({ schema, value: { ok: true } });
    expect(workerHarness.ControlledWorker.instances).toHaveLength(1);
    expect(worker.messages).toHaveLength(2);
    worker.respond(worker.messages[1].jobId);
    await expect(second).resolves.toEqual({ ok: true });

    await port.close?.();
    expect(worker.terminated).toBe(true);
    expect(worker.listenerCount()).toBe(0);
  });

  it("settles queued aborts immediately and includes starting jobs in bounded capacity", async () => {
    const validator = createIsolatedSchemaValidator();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(validator.preflight(schema, alreadyAborted.signal)).rejects.toMatchObject({ code: "schema_validation_aborted" });
    expect(workerHarness.ControlledWorker.instances).toHaveLength(0);

    const starting = Array.from({ length: 8 }, () => validator.preflight(schema).catch((error: unknown) => error));
    const controller = new AbortController();
    const queued = validator.preflight(schema, controller.signal);

    expect(validator.stats()).toMatchObject({ workers: 8, active: 8, queued: 1, deadlineTimers: 0 });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "schema_validation_aborted" });
    expect(validator.stats().queued).toBe(0);

    const capacityValidator = createIsolatedSchemaValidator();
    const accepted = Array.from({ length: 72 }, () => capacityValidator.preflight(schema).catch((error: unknown) => error));
    expect(capacityValidator.stats()).toMatchObject({ workers: 8, active: 8, queued: 64, deadlineTimers: 0 });
    await expect(capacityValidator.preflight(schema)).rejects.toMatchObject({ code: "schema_worker_capacity" });

    await Promise.all([validator.close(), capacityValidator.close()]);
    expect((await Promise.all(starting)).every((error) => error instanceof Error)).toBe(true);
    expect((await Promise.all(accepted)).every((error) => error instanceof Error)).toBe(true);
    expect(validator.stats()).toMatchObject({ workers: 0, active: 0, queued: 0, deadlineTimers: 0 });
    expect(capacityValidator.stats()).toMatchObject({ workers: 0, active: 0, queued: 0, deadlineTimers: 0 });

    const startingAbortValidator = createIsolatedSchemaValidator();
    const startingController = new AbortController();
    const startingAbortWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const startingAbort = startingAbortValidator.preflight(schema, startingController.signal);
    const startingWorker = workerAt(startingAbortWorkerIndex);
    startingController.abort();
    await expect(startingAbort).rejects.toMatchObject({ code: "schema_validation_aborted" });
    await startingAbortValidator.close();
    expect(startingWorker.terminated).toBe(true);
    expect(startingWorker.listenerCount()).toBe(0);
  });

  it("settles startup close, active cancellation, worker failure and zero-code exit exactly once", async () => {
    const validator = createIsolatedSchemaValidator();
    const startingWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const starting = validator.preflight(schema);
    const startingWorker = workerAt(startingWorkerIndex);
    const closeA = validator.close();
    const closeB = validator.close();
    await expect(starting).rejects.toMatchObject({ code: "schema_worker_closed" });
    await Promise.all([closeA, closeB]);
    expect(startingWorker.terminated).toBe(true);
    expect(startingWorker.listenerCount()).toBe(0);

    const abortValidator = createIsolatedSchemaValidator();
    const controller = new AbortController();
    const activeWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const active = abortValidator.preflight(schema, controller.signal);
    const activeWorker = workerAt(activeWorkerIndex);
    activeWorker.sendReady();
    controller.abort();
    await expect(active).rejects.toMatchObject({ code: "schema_validation_aborted" });
    await abortValidator.close();
    expect(activeWorker.terminated).toBe(true);
    expect(activeWorker.listenerCount()).toBe(0);

    const activeCloseValidator = createIsolatedSchemaValidator();
    const activeCloseWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const activeClose = activeCloseValidator.preflight(schema);
    const activeCloseWorker = workerAt(activeCloseWorkerIndex);
    activeCloseWorker.sendReady();
    const closeActiveWork = activeCloseValidator.close();
    await expect(activeClose).rejects.toMatchObject({ code: "schema_worker_closed" });
    await closeActiveWork;
    expect(activeCloseWorker.terminated).toBe(true);
    expect(activeCloseWorker.listenerCount()).toBe(0);

    const exitValidator = createIsolatedSchemaValidator();
    const exitWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const lost = exitValidator.preflight(schema);
    const exitWorker = workerAt(exitWorkerIndex);
    exitWorker.exit(0);
    await expect(lost).rejects.toMatchObject({ code: "schema_worker_lost" });
    await exitValidator.close();
    expect(exitWorker.listenerCount()).toBe(0);

    const errorValidator = createIsolatedSchemaValidator();
    const errorWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const failed = errorValidator.preflight(schema);
    const errorWorker = workerAt(errorWorkerIndex);
    errorWorker.fail();
    await expect(failed).rejects.toThrow("controlled worker failure");
    await errorValidator.close();
    expect(errorWorker.listenerCount()).toBe(0);
  });

  it("ignores a late result for an older job and releases a worker after dispatch failure", async () => {
    const validator = createIsolatedSchemaValidator();
    const first = validator.preflight(schema);
    const worker = workerAt(0);
    worker.sendReady();
    const firstJobId = worker.messages[0].jobId;
    worker.respond(firstJobId);
    await expect(first).resolves.toBeUndefined();

    const second = validator.preflight(schema);
    const secondJobId = worker.messages[1].jobId;
    expect(secondJobId).not.toBe(firstJobId);
    worker.respond(firstJobId);
    expect(validator.stats()).toMatchObject({ active: 1, deadlineTimers: 1 });
    worker.respond(secondJobId);
    await expect(second).resolves.toBeUndefined();
    await validator.close();

    const dispatchValidator = createIsolatedSchemaValidator();
    const dispatchWorkerIndex = workerHarness.ControlledWorker.instances.length;
    const dispatchFailure = dispatchValidator.preflight(schema);
    const dispatchWorker = workerAt(dispatchWorkerIndex);
    dispatchWorker.failPostMessage = new Error("dispatch failed");
    dispatchWorker.sendReady();
    await expect(dispatchFailure).rejects.toMatchObject({ code: "schema_validation_invalid" });
    await dispatchValidator.close();
    expect(dispatchWorker.terminated).toBe(true);
    expect(dispatchWorker.listenerCount()).toBe(0);
  });
});
