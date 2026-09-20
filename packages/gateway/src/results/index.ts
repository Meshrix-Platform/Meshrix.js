import type {
  CompleteResult,
  GatewayFailure,
  InputRequiredResult,
  NegotiatedExtensionResult,
  UpstreamResult
} from "@meshrix/contracts/gateway";
import { isPlainRecord } from "../utils.ts";

export { type CompleteResult, type GatewayFailure, type InputRequiredResult, type NegotiatedExtensionResult, type UpstreamResult };

export function complete(value: unknown, options: { readonly isError?: boolean; readonly requestState?: string } = {}): CompleteResult {
  return Object.freeze({ kind: "complete", value, ...(options.isError === undefined ? {} : { isError: options.isError }), ...(options.requestState === undefined ? {} : { requestState: options.requestState }) });
}

export function inputRequired(inputRequests: InputRequiredResult["inputRequests"], requestState?: string, upstreamState?: InputRequiredResult["upstreamState"]): InputRequiredResult {
  const copied = Array.isArray(inputRequests)
    ? Object.freeze(inputRequests.map((request) => Object.freeze({ ...request })))
    : Object.freeze({ ...inputRequests });
  return Object.freeze({ kind: "input_required", inputRequests: copied, ...(requestState === undefined ? {} : { requestState }), ...(upstreamState === undefined ? {} : { upstreamState }) });
}

export function negotiatedExtension(extension: string, value: unknown, requestState?: string): NegotiatedExtensionResult {
  return Object.freeze({ kind: "negotiated_extension", extension, value, ...(requestState === undefined ? {} : { requestState }) });
}

export function failure(input: Omit<GatewayFailure, "kind">): GatewayFailure {
  return Object.freeze({ kind: "failure", ...input });
}

export function isGatewayFailure(value: unknown): value is GatewayFailure {
  return isPlainRecord(value) && value.kind === "failure" && typeof value.code === "string";
}

export function isUpstreamResult(value: unknown): value is UpstreamResult {
  return isPlainRecord(value) && (value.kind === "complete" || value.kind === "input_required" || value.kind === "negotiated_extension");
}

export function decodeUpstreamResult(value: unknown, options: { readonly legacy?: boolean } = {}): UpstreamResult | GatewayFailure {
  if (isGatewayFailure(value)) return value;
  if (isUpstreamResult(value)) return value;
  if (!isPlainRecord(value)) {
    return failure({ origin: "protocol", code: "upstream_result_invalid", message: "Upstream returned an invalid result envelope.", status: 502, effectOutcome: "unknown" });
  }
  const resultType = value.resultType;
  if (resultType === "input_required") {
    if (!Array.isArray(value.inputRequests) && !isPlainRecord(value.inputRequests)) {
      return failure({ origin: "protocol", code: "input_required_invalid", message: "input_required result is missing inputRequests.", status: 502, effectOutcome: "unknown" });
    }
    const inputRequests = Array.isArray(value.inputRequests)
      ? value.inputRequests.filter(isPlainRecord)
      : value.inputRequests;
    return inputRequired(inputRequests, typeof value.requestState === "string" ? value.requestState : undefined, {
      present: typeof value.requestState === "string",
      ...(typeof value.requestState === "string" ? { value: value.requestState } : {})
    });
  }
  if (typeof resultType === "string" && resultType !== "complete") {
    if (!isPlainRecord(value.value)) return failure({ origin: "protocol", code: "negotiated_result_invalid", message: "Negotiated result is missing its value.", status: 502, effectOutcome: "unknown" });
    return negotiatedExtension(resultType, value.value, typeof value.requestState === "string" ? value.requestState : undefined);
  }
  const protocolResult = Object.hasOwn(value, "content") || Object.hasOwn(value, "structuredContent") || Object.hasOwn(value, "resource") || Object.hasOwn(value, "isError") || Object.hasOwn(value, "_meta");
  if (options.legacy || resultType === "complete" || Object.hasOwn(value, "value") || protocolResult) {
    return complete(value.value ?? value, { isError: value.isError === true, requestState: typeof value.requestState === "string" ? value.requestState : undefined });
  }
  return failure({ origin: "protocol", code: "upstream_result_type_unnegotiated", message: "Upstream result type was not negotiated.", status: 502, effectOutcome: "unknown" });
}

export function toProtocolResult(result: UpstreamResult): Record<string, unknown> {
  if (result.kind === "complete") return { resultType: "complete", value: result.value, ...(result.isError === undefined ? {} : { isError: result.isError }), ...(result.requestState === undefined ? {} : { requestState: result.requestState }) };
  if (result.kind === "input_required") return { resultType: "input_required", inputRequests: result.inputRequests, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) };
  return { resultType: result.extension, value: result.value, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) };
}
