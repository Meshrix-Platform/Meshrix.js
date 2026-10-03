import { describe, expect, it } from "vitest";
import { applyPayloadTransform, partitionPayload, preserveApplicationMetadata, rewriteKnownResourceSlots, trustedGatewayEvidence } from "@meshrix/gateway";

describe("gateway payload ownership", () => {
  it("[CASE-M01] [CASE-M02] [CASE-M03] preserves business fields and both namespaced and unprefixed application metadata", () => {
    const payload = {
      traceId: "business-trace",
      auditId: "business-audit",
      toolExecutionId: "business-execution",
      _meta: { status: "ready", "example/trace": "application" },
      "io.meshrix/governance": { effectOutcome: "succeeded" }
    };
    const partition = partitionPayload(payload);
    expect(partition.application).toEqual(payload);
    expect(partition.applicationMetadata).toEqual({ _meta: payload._meta });
    expect(partition.protocol).toEqual({});
    expect(trustedGatewayEvidence({ effectOutcome: "succeeded", permitId: "p" })).toEqual({ route: undefined, endpoint: undefined, decisionRef: undefined, permitId: "p", effectOutcome: "succeeded" });
  });

  it("[CASE-M04] [CASE-C09] only changes business content through an explicit transform and rewrites protocol slots", () => {
    const value = { traceId: "business", nested: { uri: "meshrix://upstream/a", text: "meshrix://upstream/a" } };
    expect(applyPayloadTransform(value)).toEqual(value);
    expect(applyPayloadTransform(value, { id: "normalize", version: "1", apply: (input) => ({ ...(input as object), transformed: true }) })).toHaveProperty("transformed", true);
    expect(rewriteKnownResourceSlots(value, { "meshrix://upstream/a": "meshrix://public/a" })).toEqual({ traceId: "business", nested: { uri: "meshrix://public/a", text: "meshrix://upstream/a" } });
    expect(preserveApplicationMetadata({ "business/key": "value" })).toEqual({ "business/key": "value" });
  });
});
