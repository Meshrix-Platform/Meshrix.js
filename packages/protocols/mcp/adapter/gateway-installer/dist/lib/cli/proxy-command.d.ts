export declare const MCP_STDIO_FRAMING_JSONL: any;
export declare const MCP_STDIO_FRAMING_CONTENT_LENGTH: any;
export declare const MCP_STDIO_MAX_FRAME_BYTES: any;
export declare const MCP_STDIO_MAX_BUFFER_BYTES: any;
export declare const MCP_PROXY_MAX_ACTIVE_REQUESTS: any;
export declare const MCP_PROXY_MAX_PENDING_DISPATCHES: any;
export declare function encodeStdioJsonRpc(payload?: any, framing?: any): any;
export declare function extractStdioMessage(buffer?: any, { maxFrameBytes }?: Record<string, any>): any;
export declare function forwardProxyMessage({ baseUrl, token, target, message, signal, proxySessionId }: Record<string, any>): Promise<any>;
export declare function createProxyRequestDispatcher({ baseUrl, token, target, forwardMessage, writeMessage, writable, proxySessionId, maxOutputQueuedBytes, maxOutputQueuedMessages, outputDrainTimeoutMs, onOutputFailure, maxActiveRequests, maxPendingDispatches }?: Record<string, any>): any;
export declare function createProxyStdioTransport(options?: Record<string, any>): any;
export declare function resolveProxyCredentials(options?: Record<string, any>): Promise<any>;
export declare function proxyCommand(options?: Record<string, any>): Promise<any>;
//# sourceMappingURL=proxy-command.d.ts.map