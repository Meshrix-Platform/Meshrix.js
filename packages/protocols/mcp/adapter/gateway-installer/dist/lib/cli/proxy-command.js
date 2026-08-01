import { loadProcessIdentity } from "../process-identity-store.js";
import { createMcpProxySessionId, MCP_PROXY_SESSION_HEADER, normalizeMcpProxySessionId } from "../mcp-proxy-session.js";
import { createBoundedStdioOutput } from "./bounded-stdio-output.js";
import { HTTP_TIMEOUT_MS } from "./constants.js";
import { normalizeTarget, option } from "./basic-utils.js";
import { fetchJson } from "./http-json-client.js";
import { optionsWithDiscoveredBaseUrl, resolveToken, signedAuthHeaders } from "./discovery.js";
import { installerOptions } from "./installer-options.js";
export const MCP_STDIO_FRAMING_JSONL = "jsonl";
export const MCP_STDIO_FRAMING_CONTENT_LENGTH = "content-length";
export const MCP_STDIO_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MCP_STDIO_MAX_BUFFER_BYTES = MCP_STDIO_MAX_FRAME_BYTES + (64 * 1024);
export const MCP_PROXY_MAX_ACTIVE_REQUESTS = 32;
export const MCP_PROXY_MAX_PENDING_DISPATCHES = 96;
function positiveInteger(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a positive safe integer.`);
    }
    return resolved;
}
function stdioFrameError(message, framing, { fatal = false, rest = Buffer.alloc(0) } = {}) {
    return {
        error: new Error(message),
        errorCode: -32700,
        fatal,
        framing,
        rest
    };
}
export function encodeStdioJsonRpc(payload, framing = MCP_STDIO_FRAMING_JSONL) {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    if (framing === MCP_STDIO_FRAMING_CONTENT_LENGTH) {
        return Buffer.concat([
            Buffer.from(`Content-Length: ${data.length}\r\n\r\n`, "utf8"),
            data
        ]);
    }
    return Buffer.concat([data, Buffer.from("\n", "utf8")]);
}
export function extractStdioMessage(buffer, { maxFrameBytes = MCP_STDIO_MAX_FRAME_BYTES } = {}) {
    const frameLimit = positiveInteger(maxFrameBytes, MCP_STDIO_MAX_FRAME_BYTES, "maxFrameBytes");
    const contentLengthPrefix = "content-length:";
    const prefixProbe = buffer
        .subarray(0, Math.min(buffer.length, contentLengthPrefix.length))
        .toString("ascii")
        .toLowerCase();
    const couldBeContentLength = contentLengthPrefix.startsWith(prefixProbe);
    const isContentLength = prefixProbe === contentLengthPrefix;
    if (isContentLength || couldBeContentLength) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
            return null;
        }
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const lengthMatch = headerText.match(/^content-length:\s*(\d+)\s*$/im);
        if (!lengthMatch) {
            return stdioFrameError("Invalid MCP Content-Length header.", MCP_STDIO_FRAMING_CONTENT_LENGTH, { fatal: true });
        }
        const length = Number(lengthMatch[1]);
        if (!Number.isSafeInteger(length) || length > frameLimit) {
            return stdioFrameError("MCP stdio frame limit exceeded.", MCP_STDIO_FRAMING_CONTENT_LENGTH, { fatal: true });
        }
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) {
            return null;
        }
        const rest = buffer.subarray(bodyStart + length);
        try {
            return {
                message: JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")),
                framing: MCP_STDIO_FRAMING_CONTENT_LENGTH,
                rest
            };
        }
        catch {
            return stdioFrameError("Invalid JSON-RPC frame.", MCP_STDIO_FRAMING_CONTENT_LENGTH, { rest });
        }
    }
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
        const rest = buffer.subarray(newline + 1);
        if (newline > frameLimit) {
            return stdioFrameError("MCP stdio frame limit exceeded.", MCP_STDIO_FRAMING_JSONL, { rest });
        }
        const line = buffer.subarray(0, newline).toString("utf8").trim();
        try {
            return {
                message: line ? JSON.parse(line) : null,
                framing: MCP_STDIO_FRAMING_JSONL,
                rest
            };
        }
        catch {
            return stdioFrameError("Invalid JSON-RPC frame.", MCP_STDIO_FRAMING_JSONL, { rest });
        }
    }
    if (buffer.length > frameLimit) {
        return stdioFrameError("MCP stdio frame limit exceeded.", MCP_STDIO_FRAMING_JSONL, { fatal: true });
    }
    return null;
}
export async function forwardProxyMessage({ baseUrl, token, target, message, signal, proxySessionId }) {
    const correlationSessionId = normalizeMcpProxySessionId(proxySessionId);
    if (!correlationSessionId) {
        throw new Error("MCP proxy session correlation is unavailable.");
    }
    const body = JSON.stringify(message);
    const response = await fetchJson(`${baseUrl}/mcp`, {
        method: "POST",
        timeoutMs: HTTP_TIMEOUT_MS,
        signal,
        headers: {
            ...await signedAuthHeaders({ baseUrl, token, target, method: "POST", body }),
            [MCP_PROXY_SESSION_HEADER]: correlationSessionId
        },
        body
    });
    if (!response.ok) {
        return {
            jsonrpc: "2.0",
            id: message?.id ?? null,
            error: {
                code: -32001,
                message: response.payload?.error?.message || response.payload?.error || `Meshrix MCP proxy failed with HTTP ${response.status}`
            }
        };
    }
    return response.payload;
}
function hasJsonRpcRequestId(message) {
    return message?.id !== undefined && message?.id !== null;
}
function isCancellationNotification(message) {
    return !hasJsonRpcRequestId(message) && message?.method === "notifications/cancelled";
}
function requestCancellationError() {
    const error = new Error("MCP request cancelled.");
    error.name = "AbortError";
    return error;
}
export function createProxyRequestDispatcher({ baseUrl, token, target, forwardMessage = forwardProxyMessage, writeMessage, writable = process.stdout, proxySessionId = createMcpProxySessionId(), maxOutputQueuedBytes, maxOutputQueuedMessages, outputDrainTimeoutMs, onOutputFailure = () => { }, maxActiveRequests = MCP_PROXY_MAX_ACTIVE_REQUESTS, maxPendingDispatches = MCP_PROXY_MAX_PENDING_DISPATCHES } = {}) {
    const activeRequestLimit = positiveInteger(maxActiveRequests, MCP_PROXY_MAX_ACTIVE_REQUESTS, "maxActiveRequests");
    const pendingDispatchLimit = positiveInteger(maxPendingDispatches, MCP_PROXY_MAX_PENDING_DISPATCHES, "maxPendingDispatches");
    const correlationSessionId = normalizeMcpProxySessionId(proxySessionId);
    if (!correlationSessionId) {
        throw new TypeError("MCP proxy session correlation identifier is invalid.");
    }
    const activeRequests = new Map();
    const pendingDispatches = new Set();
    let cancellationReservations = 0;
    let stopped = false;
    let outputFailure = null;
    let resolveOutputFailure;
    const failure = new Promise((resolve) => {
        resolveOutputFailure = resolve;
    });
    function handleOutputFailure(error) {
        if (outputFailure) {
            return;
        }
        outputFailure = error instanceof Error ? error : new Error("MCP proxy output failed.");
        resolveOutputFailure(outputFailure);
        stop();
        try {
            onOutputFailure(outputFailure);
        }
        catch { }
    }
    const boundedOutput = typeof writeMessage === "function"
        ? null
        : createBoundedStdioOutput({
            writable,
            maxQueuedBytes: maxOutputQueuedBytes,
            maxQueuedMessages: maxOutputQueuedMessages,
            drainTimeoutMs: outputDrainTimeoutMs,
            onFailure: handleOutputFailure
        });
    function emitMessage(payload, framing = MCP_STDIO_FRAMING_JSONL) {
        if (outputFailure) {
            return false;
        }
        if (boundedOutput) {
            return boundedOutput.write(encodeStdioJsonRpc(payload, framing));
        }
        try {
            const accepted = writeMessage(payload, framing);
            if (accepted === false) {
                handleOutputFailure(new Error("MCP proxy output rejected a response."));
                return false;
            }
            return true;
        }
        catch (error) {
            handleOutputFailure(error);
            return false;
        }
    }
    function pendingWorkCount() {
        return pendingDispatches.size + cancellationReservations;
    }
    function hasPendingCapacity(requiredSlots = 1) {
        return pendingWorkCount() + requiredSlots <= pendingDispatchLimit;
    }
    function trackDispatch(promise) {
        pendingDispatches.add(promise);
        promise.finally(() => pendingDispatches.delete(promise));
        return promise;
    }
    function forwardNotification(message, { reserved = false } = {}) {
        if (!reserved && !hasPendingCapacity()) {
            return false;
        }
        return trackDispatch((async () => {
            try {
                await forwardMessage({
                    baseUrl,
                    token,
                    target,
                    message,
                    proxySessionId: correlationSessionId
                });
            }
            catch {
                // JSON-RPC notifications are best-effort and never produce responses.
            }
        })()) && true;
    }
    function writeCapacityError(requestId, framing) {
        emitMessage({
            jsonrpc: "2.0",
            id: requestId,
            error: { code: -32000, message: "MCP proxy request capacity exceeded." }
        }, framing);
    }
    function releaseCancellationReservation(entry) {
        if (!entry.cancellationReserved) {
            return false;
        }
        entry.cancellationReserved = false;
        cancellationReservations -= 1;
        return true;
    }
    function dispatchRequest(message, framing) {
        const requestId = message.id;
        if (activeRequests.has(requestId)) {
            emitMessage({
                jsonrpc: "2.0",
                id: requestId,
                error: { code: -32600, message: "Duplicate in-flight JSON-RPC request id." }
            }, framing);
            return;
        }
        if (activeRequests.size >= activeRequestLimit || !hasPendingCapacity(2)) {
            writeCapacityError(requestId, framing);
            return;
        }
        const controller = new AbortController();
        const entry = { controller, cancellationReserved: true, cancelled: false };
        activeRequests.set(requestId, entry);
        cancellationReservations += 1;
        const promise = (async () => {
            try {
                const forwarded = await forwardMessage({
                    baseUrl,
                    token,
                    target,
                    message,
                    signal: controller.signal,
                    proxySessionId: correlationSessionId
                });
                if (controller.signal.aborted) {
                    return;
                }
                emitMessage(forwarded, framing);
            }
            catch (error) {
                if (controller.signal.aborted) {
                    return;
                }
                emitMessage({
                    jsonrpc: "2.0",
                    id: requestId,
                    error: { code: -32001, message: error.message || "Meshrix MCP proxy forwarding failed." }
                }, framing);
            }
            finally {
                releaseCancellationReservation(entry);
                if (activeRequests.get(requestId) === entry) {
                    activeRequests.delete(requestId);
                }
            }
        })();
        trackDispatch(promise);
    }
    function dispatch(message, framing = MCP_STDIO_FRAMING_JSONL) {
        if (stopped) {
            return;
        }
        if (isCancellationNotification(message)) {
            const activeRequest = activeRequests.get(message?.params?.requestId);
            if (!activeRequest) {
                return;
            }
            if (activeRequest.cancelled) {
                return;
            }
            const requestId = message.params.requestId;
            activeRequest.cancelled = true;
            activeRequest.controller.abort(requestCancellationError());
            const hadReservation = releaseCancellationReservation(activeRequest);
            forwardNotification({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId }
            }, { reserved: hadReservation });
            return;
        }
        if (!hasJsonRpcRequestId(message)) {
            forwardNotification(message);
            return;
        }
        dispatchRequest(message, framing);
    }
    function stop() {
        if (stopped) {
            return;
        }
        stopped = true;
        for (const [requestId, activeRequest] of activeRequests) {
            if (activeRequest.cancelled) {
                continue;
            }
            activeRequest.cancelled = true;
            activeRequest.controller.abort(requestCancellationError());
            const hadReservation = releaseCancellationReservation(activeRequest);
            forwardNotification({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId }
            }, { reserved: hadReservation });
        }
    }
    async function waitForIdle() {
        while (pendingDispatches.size > 0) {
            await Promise.allSettled([...pendingDispatches]);
        }
        await boundedOutput?.waitForIdle();
        if (outputFailure) {
            throw outputFailure;
        }
    }
    return {
        dispatch,
        stop,
        write: emitMessage,
        waitForIdle,
        failure,
        get activeRequestCount() {
            return activeRequests.size;
        },
        get pendingDispatchCount() {
            return pendingDispatches.size;
        },
        get pendingWorkCount() {
            return pendingWorkCount();
        },
        get outputSnapshot() {
            return boundedOutput?.snapshot() || Object.freeze({
                pendingBytes: 0,
                pendingMessages: 0,
                blocked: false,
                failed: Boolean(outputFailure),
                maxQueuedBytes: 0,
                maxQueuedMessages: 0
            });
        }
    };
}
export function createProxyStdioTransport(options = {}) {
    let buffer = Buffer.alloc(0);
    let inputFailed = false;
    const callerOutputFailure = options.onOutputFailure;
    const dispatcher = createProxyRequestDispatcher({
        ...options,
        onOutputFailure(error) {
            inputFailed = true;
            buffer = Buffer.alloc(0);
            callerOutputFailure?.(error);
        }
    });
    const maxFrameBytes = positiveInteger(options.maxFrameBytes, MCP_STDIO_MAX_FRAME_BYTES, "maxFrameBytes");
    const maxBufferBytes = positiveInteger(options.maxBufferBytes, MCP_STDIO_MAX_BUFFER_BYTES, "maxBufferBytes");
    function writeInputError(error, framing = MCP_STDIO_FRAMING_JSONL) {
        dispatcher.write({
            jsonrpc: "2.0",
            id: null,
            error: {
                code: error?.errorCode || -32700,
                message: error?.message || "Invalid JSON-RPC frame."
            }
        }, framing);
    }
    function drainBuffer() {
        let consumed = false;
        while (true) {
            const beforeLength = buffer.length;
            const extracted = extractStdioMessage(buffer, { maxFrameBytes });
            if (!extracted) {
                return consumed;
            }
            buffer = extracted.rest;
            consumed ||= buffer.length < beforeLength;
            if (extracted.error) {
                writeInputError(extracted.error, extracted.framing || MCP_STDIO_FRAMING_JSONL);
                if (extracted.fatal) {
                    inputFailed = true;
                    buffer = Buffer.alloc(0);
                    return true;
                }
                continue;
            }
            if (extracted.message) {
                dispatcher.dispatch(extracted.message, extracted.framing || MCP_STDIO_FRAMING_JSONL);
            }
        }
    }
    function push(chunk) {
        if (inputFailed) {
            return;
        }
        let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        while (incoming.length > 0 && !inputFailed) {
            const available = maxBufferBytes - buffer.length;
            if (available <= 0) {
                const drained = drainBuffer();
                if (!drained && buffer.length >= maxBufferBytes) {
                    writeInputError(new Error("MCP stdio input buffer limit exceeded."));
                    inputFailed = true;
                    buffer = Buffer.alloc(0);
                }
                continue;
            }
            const acceptedBytes = Math.min(available, incoming.length);
            buffer = Buffer.concat([buffer, incoming.subarray(0, acceptedBytes)]);
            incoming = incoming.subarray(acceptedBytes);
            drainBuffer();
        }
    }
    return {
        push,
        close: dispatcher.waitForIdle,
        failure: dispatcher.failure,
        get activeRequestCount() {
            return dispatcher.activeRequestCount;
        },
        get pendingDispatchCount() {
            return dispatcher.pendingDispatchCount;
        },
        get pendingWorkCount() {
            return dispatcher.pendingWorkCount;
        },
        get inputFailed() {
            return inputFailed;
        },
        get outputSnapshot() {
            return dispatcher.outputSnapshot;
        }
    };
}
export async function resolveProxyCredentials(options = {}) {
    const target = normalizeTarget(option(options, "target", "opencode")) || "opencode";
    const providedToken = await resolveToken(options, { required: false });
    const identity = await loadProcessIdentity(target);
    if (!identity) {
        throw new Error(`Missing local process identity for ${target}. Run meshrix-mcp install --target ${target} first.`);
    }
    const token = providedToken || String(identity.grantToken || "").trim();
    if (!token) {
        throw new Error(`Missing stored MCP grant credential for ${target}. ` +
            `Run meshrix-mcp uninstall --target ${target}, then reinstall before starting the proxy.`);
    }
    return {
        target,
        token,
        identity,
        tokenSource: providedToken ? "provided" : "credential-store"
    };
}
export async function proxyCommand(options = {}) {
    const resolved = await optionsWithDiscoveredBaseUrl(options);
    const settings = installerOptions(resolved);
    const { target, token } = await resolveProxyCredentials(options);
    const transport = createProxyStdioTransport({
        baseUrl: settings.baseUrl,
        token,
        target
    });
    const onData = (chunk) => {
        transport.push(chunk);
    };
    let onEnd;
    const inputEnded = new Promise((resolve) => {
        onEnd = () => resolve(null);
        process.stdin.once("end", onEnd);
    });
    process.stdin.on("data", onData);
    const outputFailure = await Promise.race([inputEnded, transport.failure]);
    if (outputFailure) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.pause();
    }
    await transport.close();
    return { ok: true, proxy: "closed" };
}
//# sourceMappingURL=proxy-command.js.map