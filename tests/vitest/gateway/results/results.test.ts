import { describe, expect, it } from "vitest";
import { complete, decodeUpstreamResult, failure, inputRequired, negotiatedExtension, toProtocolResult } from "@meshrix/gateway";

describe("gateway result union", () => {
  it("[CASE-P04] keeps complete, input-required, and negotiated-extension results exhaustive", () => {
    const done = complete({ content: [{ type: "text", text: "ok" }] });
    const needsInput = inputRequired({ "confirm-name": { method: "elicitation/create" } }, "opaque-state", { present: true, value: "opaque-state" });
    const extension = negotiatedExtension("meshrix/extension", { accepted: true });
    expect(toProtocolResult(done)).toMatchObject({ resultType: "complete" });
    expect(toProtocolResult(needsInput)).toMatchObject({ resultType: "input_required", requestState: "opaque-state" });
    expect(toProtocolResult(extension)).toMatchObject({ resultType: "meshrix/extension" });
  });

  it("[CASE-P05] does not coerce unknown result types into complete results", () => {
    expect(decodeUpstreamResult({ resultType: "unsupported", value: { ok: true } })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult({ resultType: "input_required", inputRequests: { ask: { method: "elicitation/create" } }, requestState: "opaque" })).toMatchObject({ kind: "input_required", upstreamState: { present: true, value: "opaque" } });
    expect(decodeUpstreamResult({ resultType: "not-negotiated" })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
  });

  it("[CASE-P06] requires a negotiated result type for modern wire results and preserves explicit legacy decoding", () => {
    const contentOnly = { content: [{ type: "text", text: "ok" }] };
    expect(decodeUpstreamResult(contentOnly)).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated", effectOutcome: "unknown" });
    expect(decodeUpstreamResult({ structuredContent: { ok: true } })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult({ resource: { uri: "fixture://resource" } })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult({ isError: true, content: [] })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult({ _meta: { fixture: true } })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated" });
    expect(decodeUpstreamResult(contentOnly, { legacy: true })).toMatchObject({ kind: "complete" });
    expect(decodeUpstreamResult({ resultType: "complete", content: [] })).toMatchObject({ kind: "complete", isError: false });
    expect(decodeUpstreamResult({ resultType: "complete", isError: true })).toMatchObject({ kind: "complete", isError: true });
    expect(decodeUpstreamResult({ resultType: "complete", isError: false })).toMatchObject({ kind: "complete", isError: false });
    expect(decodeUpstreamResult({ resultType: "complete", isError: "true" })).toMatchObject({ kind: "failure", code: "upstream_result_invalid", origin: "protocol", effectOutcome: "unknown" });
    expect(decodeUpstreamResult(failure({ origin: "peer", code: "peer_failed", message: "peer", status: 502, effectOutcome: "failed" }))).toMatchObject({ kind: "failure", origin: "protocol" });
    expect(decodeUpstreamResult(null)).toMatchObject({ kind: "failure", code: "upstream_result_invalid" });
  });
});
