import { abortError, boundedInteger } from "../utils.ts";

export interface AdmissionOptions {
  readonly maxInFlight?: number;
  readonly queueSize?: number;
  readonly defaultQueueDeadlineMs?: number;
  readonly maxBuckets?: number;
}

interface Waiting<T> {
  readonly task: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  readonly deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  settled: boolean;
}

interface Bucket {
  readonly key: string;
  active: number;
  completed: number;
  rejected: number;
  readonly queue: Waiting<unknown>[];
}

function admissionError(code: string, message: string, status = 429): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

export class UpstreamAdmissionController {
  readonly #maxInFlight: number;
  readonly #queueSize: number;
  readonly #defaultQueueDeadlineMs: number;
  readonly #maxBuckets: number;
  readonly #buckets = new Map<string, Bucket>();
  #closed = false;

  constructor(options: AdmissionOptions = {}) {
    this.#maxInFlight = boundedInteger(options.maxInFlight, 32, 1, 65_536);
    this.#queueSize = boundedInteger(options.queueSize, 128, 0, 1_000_000);
    this.#defaultQueueDeadlineMs = boundedInteger(options.defaultQueueDeadlineMs, 30_000, 1, 86_400_000);
    this.#maxBuckets = boundedInteger(options.maxBuckets, 2048, 1, 65_536);
  }

  async run<T>(key: string, task: () => Promise<T>, options: { readonly signal?: AbortSignal; readonly deadline?: number } = {}): Promise<T> {
    if (this.#closed) throw admissionError("gateway_closing", "Gateway admission is closed.", 503);
    const bucket = this.#bucket(key);
    if (bucket.active < this.#maxInFlight && bucket.queue.length === 0) return this.#execute(bucket, task);
    if (bucket.queue.length >= this.#queueSize) {
      bucket.rejected += 1;
      throw admissionError("admission_queue_full", "The upstream admission queue is full.");
    }
    if (options.signal?.aborted) throw abortError();
    const deadline = options.deadline ?? Date.now() + this.#defaultQueueDeadlineMs;
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiting<T> = { task, resolve, reject, signal: options.signal, deadline, settled: false };
      const rejectWaiter = (reason: unknown): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abortListener) waiter.signal?.removeEventListener("abort", waiter.abortListener);
        const index = bucket.queue.indexOf(waiter as Waiting<unknown>);
        if (index >= 0) bucket.queue.splice(index, 1);
        bucket.rejected += 1;
        reject(reason);
      };
      const onAbort = (): void => rejectWaiter(abortError());
      waiter.abortListener = onAbort;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      waiter.timer = setTimeout(() => rejectWaiter(admissionError("admission_queue_deadline", "The request expired while waiting for upstream capacity.")), Math.max(0, deadline - Date.now()));
      bucket.queue.push(waiter as Waiting<unknown>);
    });
  }

  close(): void {
    this.#closed = true;
    for (const bucket of this.#buckets.values()) {
      for (const waiter of bucket.queue.splice(0)) {
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abortListener) waiter.signal?.removeEventListener("abort", waiter.abortListener);
        waiter.reject(admissionError("gateway_closing", "Gateway admission closed before execution.", 503));
      }
      if (bucket.active === 0) this.#buckets.delete(bucket.key);
    }
  }

  stats(): Readonly<Record<string, unknown>> {
    const upstreams: Record<string, unknown> = {};
    let active = 0;
    let queued = 0;
    for (const [key, bucket] of this.#buckets) {
      active += bucket.active;
      queued += bucket.queue.length;
      upstreams[key] = { active: bucket.active, queued: bucket.queue.length, completed: bucket.completed, rejected: bucket.rejected };
    }
    const timers = [...this.#buckets.values()].reduce((count, bucket) => count + bucket.queue.filter((entry) => entry.timer !== undefined).length, 0);
    return Object.freeze({ maxInFlight: this.#maxInFlight, queueSize: this.#queueSize, active, queued, timers, buckets: this.#buckets.size, upstreams });
  }

  async #execute<T>(bucket: Bucket, task: () => Promise<T>): Promise<T> {
    bucket.active += 1;
    try {
      const value = await task();
      bucket.completed += 1;
      return value;
    } finally {
      bucket.active -= 1;
      this.#pump(bucket);
      if (this.#closed && bucket.active === 0) this.#buckets.delete(bucket.key);
    }
  }

  #pump(bucket: Bucket): void {
    while (!this.#closed && bucket.active < this.#maxInFlight && bucket.queue.length > 0) {
      const waiter = bucket.queue.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.abortListener) waiter.signal?.removeEventListener("abort", waiter.abortListener);
      void this.#execute(bucket, waiter.task).then(waiter.resolve, waiter.reject);
    }
  }

  #bucket(key: string): Bucket {
    const normalized = key.trim() || "default";
    let bucket = this.#buckets.get(normalized);
    if (!bucket) {
      if (this.#buckets.size >= this.#maxBuckets) {
        const idle = [...this.#buckets].find(([, candidate]) => candidate.active === 0 && candidate.queue.length === 0)?.[0];
        if (!idle) throw admissionError("admission_upstream_capacity", "Upstream admission capacity is exhausted.");
        this.#buckets.delete(idle);
      }
      bucket = { key: normalized, active: 0, completed: 0, rejected: 0, queue: [] };
      this.#buckets.set(normalized, bucket);
    }
    return bucket;
  }
}

export function createUpstreamAdmission(options: AdmissionOptions = {}): UpstreamAdmissionController {
  return new UpstreamAdmissionController(options);
}
