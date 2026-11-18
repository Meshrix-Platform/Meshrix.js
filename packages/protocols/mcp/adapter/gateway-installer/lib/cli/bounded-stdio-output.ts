const DEFAULT_MAX_QUEUED_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES: any = 64;
const DEFAULT_DRAIN_TIMEOUT_MS: any = 30_000;

function positiveInteger(value?: any, fallback?: any, name?: any) : any {
  const resolved: any = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function outputError(message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = "MCP_PROXY_OUTPUT_FAILED";
  return error;
}

export function createBoundedStdioOutput({
  writable = process.stdout,
  maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
  maxQueuedMessages = DEFAULT_MAX_QUEUED_MESSAGES,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  onFailure = () : any => {}
}: Record<string, any> = {}) : any {
  if (!writable || typeof writable.write !== "function") {
    throw new TypeError("MCP proxy output must be a writable stream.");
  }
  const byteLimit: any = positiveInteger(
    maxQueuedBytes,
    DEFAULT_MAX_QUEUED_BYTES,
    "maxQueuedBytes"
  );
  const messageLimit: any = positiveInteger(
    maxQueuedMessages,
    DEFAULT_MAX_QUEUED_MESSAGES,
    "maxQueuedMessages"
  );
  const resolvedDrainTimeoutMs: any = positiveInteger(
    drainTimeoutMs,
    DEFAULT_DRAIN_TIMEOUT_MS,
    "drainTimeoutMs"
  );
  const queue: any[] = [];
  const idleWaiters: any = new Set<any>();
  let blocked: any = null;
  let drainTimer: any = null;
  let failed: any = null;
  let pendingBytes: any = 0;
  let pendingMessages: any = 0;

  function snapshot() : any {
    return Object.freeze({
      pendingBytes,
      pendingMessages,
      blocked: Boolean(blocked),
      failed: Boolean(failed),
      maxQueuedBytes: byteLimit,
      maxQueuedMessages: messageLimit
    });
  }

  function settleIdleWaiters() : any {
    if (!failed && (pendingMessages > 0 || blocked)) {
      return;
    }
    for (const waiter of idleWaiters) {
      if (failed) {
        waiter.reject(failed);
      } else {
        waiter.resolve();
      }
    }
    idleWaiters.clear();
  }

  function clearDrainState() : any {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (typeof writable.removeListener === "function") {
      writable.removeListener("drain", handleDrain);
    }
  }

  function fail(error?: any) : any {
    if (failed) {
      return;
    }
    failed = error instanceof Error ? error : outputError("MCP proxy output failed.");
    clearDrainState();
    queue.length = 0;
    blocked = null;
    pendingBytes = 0;
    pendingMessages = 0;
    try {
      onFailure(failed);
    } catch {}
    settleIdleWaiters();
  }

  function handleDrain() : any {
    if (failed || !blocked) {
      return;
    }
    clearDrainState();
    pendingBytes -= blocked.bytes;
    pendingMessages -= 1;
    blocked = null;
    pump();
  }

  function waitForDrain(entry?: any) : any {
    blocked = entry;
    if (typeof writable.once !== "function") {
      fail(outputError("MCP proxy output cannot report drain readiness."));
      return;
    }
    writable.once("drain", handleDrain);
    drainTimer = setTimeout(() : any => {
      fail(outputError("MCP proxy output drain timed out."));
    }, resolvedDrainTimeoutMs);
  }

  function pump() : any {
    while (!failed && !blocked && queue.length > 0) {
      const entry: any = queue.shift();
      let accepted: any;
      try {
        accepted = writable.write(entry.frame);
      } catch (error: any) {
        fail(error);
        return;
      }
      if (accepted === false) {
        entry.frame = null;
        waitForDrain(entry);
        return;
      }
      pendingBytes -= entry.bytes;
      pendingMessages -= 1;
    }
    settleIdleWaiters();
  }

  function write(frame?: any) : any {
    if (failed) {
      return false;
    }
    const resolvedFrame: any = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const nextBytes: any = pendingBytes + resolvedFrame.length;
    const nextMessages: any = pendingMessages + 1;
    if (nextBytes > byteLimit || nextMessages > messageLimit) {
      fail(outputError("MCP proxy output capacity exceeded."));
      return false;
    }
    queue.push({ frame: resolvedFrame, bytes: resolvedFrame.length });
    pendingBytes = nextBytes;
    pendingMessages = nextMessages;
    pump();
    return !failed;
  }

  function waitForIdle() : any {
    if (failed) {
      return Promise.reject(failed);
    }
    if (pendingMessages === 0 && !blocked) {
      return Promise.resolve();
    }
    return new Promise((resolve?: any, reject?: any) : any => {
      idleWaiters.add({ resolve, reject });
    });
  }

  if (typeof writable.once === "function") {
    writable.once("error", fail);
  }

  return Object.freeze({
    write,
    waitForIdle,
    snapshot
  });
}
