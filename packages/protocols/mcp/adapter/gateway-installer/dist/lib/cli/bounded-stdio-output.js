const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 64;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
function positiveInteger(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
    return resolved;
}
function outputError(message) {
    const error = new Error(message);
    error.code = "MCP_PROXY_OUTPUT_FAILED";
    return error;
}
export function createBoundedStdioOutput({ writable = process.stdout, maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES, maxQueuedMessages = DEFAULT_MAX_QUEUED_MESSAGES, drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, onFailure = () => { } } = {}) {
    if (!writable || typeof writable.write !== "function") {
        throw new TypeError("MCP proxy output must be a writable stream.");
    }
    const byteLimit = positiveInteger(maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, "maxQueuedBytes");
    const messageLimit = positiveInteger(maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES, "maxQueuedMessages");
    const resolvedDrainTimeoutMs = positiveInteger(drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, "drainTimeoutMs");
    const queue = [];
    const idleWaiters = new Set();
    let blocked = null;
    let drainTimer = null;
    let failed = null;
    let pendingBytes = 0;
    let pendingMessages = 0;
    function snapshot() {
        return Object.freeze({
            pendingBytes,
            pendingMessages,
            blocked: Boolean(blocked),
            failed: Boolean(failed),
            maxQueuedBytes: byteLimit,
            maxQueuedMessages: messageLimit
        });
    }
    function settleIdleWaiters() {
        if (!failed && (pendingMessages > 0 || blocked)) {
            return;
        }
        for (const waiter of idleWaiters) {
            if (failed) {
                waiter.reject(failed);
            }
            else {
                waiter.resolve();
            }
        }
        idleWaiters.clear();
    }
    function clearDrainState() {
        if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
        }
        if (typeof writable.removeListener === "function") {
            writable.removeListener("drain", handleDrain);
        }
    }
    function fail(error) {
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
        }
        catch { }
        settleIdleWaiters();
    }
    function handleDrain() {
        if (failed || !blocked) {
            return;
        }
        clearDrainState();
        pendingBytes -= blocked.bytes;
        pendingMessages -= 1;
        blocked = null;
        pump();
    }
    function waitForDrain(entry) {
        blocked = entry;
        if (typeof writable.once !== "function") {
            fail(outputError("MCP proxy output cannot report drain readiness."));
            return;
        }
        writable.once("drain", handleDrain);
        drainTimer = setTimeout(() => {
            fail(outputError("MCP proxy output drain timed out."));
        }, resolvedDrainTimeoutMs);
    }
    function pump() {
        while (!failed && !blocked && queue.length > 0) {
            const entry = queue.shift();
            let accepted;
            try {
                accepted = writable.write(entry.frame);
            }
            catch (error) {
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
    function write(frame) {
        if (failed) {
            return false;
        }
        const resolvedFrame = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
        const nextBytes = pendingBytes + resolvedFrame.length;
        const nextMessages = pendingMessages + 1;
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
    function waitForIdle() {
        if (failed) {
            return Promise.reject(failed);
        }
        if (pendingMessages === 0 && !blocked) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
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
//# sourceMappingURL=bounded-stdio-output.js.map