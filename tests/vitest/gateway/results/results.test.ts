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
    expect(decodeUpstreamResult({ resultType: "unsupported", value: { ok: true } })).toMatchObject({ kind: "negotiated_extension", extension: "unsupported" });
    expect(decodeUpstreamResult({ resultType: "input_required", inputRequests: { ask: { method: "elicitation/create" } }, requestState: "opaque" })).toMatchObject({ kind: "input_required", upstreamState: { present: true, value: "opaque" } });
    expect(decodeUpstreamResult({ resultType: "not-negotiated" })).toMatchObject({ kind: "failure", code: "negotiated_result_invalid" });
  });

  it("[CASE-P06] distinguishes protocol-shaped MCP results, peer errors, and gateway failures", () => {
    expect(decodeUpstreamResult({ content: [{ type: "text", text: "ok" }] })).toMatchObject({ kind: "complete" });
    expect(decodeUpstreamResult(failure({ origin: "peer", code: "peer_failed", message: "peer", status: 502, effectOutcome: "failed" }))).toMatchObject({ kind: "failure", origin: "peer" });
    expect(decodeUpstreamResult(null)).toMatchObject({ kind: "failure", code: "upstream_result_invalid" });
  });
});

