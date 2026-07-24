import { postJson } from "./bridge-http";

type JsonRpcEnvelope<T> = {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

let rpcSequence = 0;

export async function callRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = `console-rpc-${++rpcSequence}`;
  const envelope = await postJson<JsonRpcEnvelope<T>>("/api/rpc", {
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
  if (envelope.error) {
    throw new Error(envelope.error.message || `RPC failed: ${method}`);
  }
  return envelope.result as T;
}
