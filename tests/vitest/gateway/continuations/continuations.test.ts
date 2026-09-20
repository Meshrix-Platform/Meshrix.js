import { describe, expect, it } from "vitest";
import { createGateway, createContinuationCodec } from "@meshrix/gateway";
import { context, descriptor, QueueUpstream, key, response } from "../support";

describe("gateway MRTR continuation binding", () => {
  it("[CASE-R01] wraps upstream requestState, restores it exactly, and carries input responses", async () => {
    const upstream = new QueueUpstream([
      response({ resultType: "input_required", requestState: "opaque-upstream-state", inputRequests: { confirm: { method: "elicitation/create" } } }),
      response({ resultType: "complete", value: { accepted: true } })
    ]);
    const gateway = createGateway({ upstream, continuationKey: key(), descriptors: [descriptor()] });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { name: "demo", arguments: { traceId: "business" } } });
      expect(first.kind).toBe("input_required");
      if (first.kind !== "input_required") throw new Error("expected input_required");
      expect(first.requestState).toMatch(/^mxcs1\./u);
      expect(first.inputRequests).toEqual({ confirm: { method: "elicitation/create" } });
      const second = await gateway.continue(context, first.requestState as string, [{ id: "confirm", action: "accept" }]);
      expect(second).toMatchObject({ kind: "complete", value: { accepted: true } });
      expect(upstream.requests[1].request.requestState).toBe("opaque-upstream-state");
      expect(upstream.requests[1].request.params).toMatchObject({ inputResponses: [{ id: "confirm", action: "accept" }] });
    } finally {
      await gateway.close();
    }
  });

  it("restores normalized present upstream state on continuation", async () => {
    const requests: Array<{ requestState?: string }> = [];
    let call = 0;
    const gateway = createGateway({
      continuationKey: key(),
      descriptors: [descriptor()],
      upstream: {
        invoke: async (input) => {
          requests.push(input.request);
          call += 1;
          return call === 1
            ? { kind: "input_required", inputRequests: [], upstreamState: { present: true, value: "normalized-state" } }
            : response({ resultType: "complete", value: "done" });
        }
      }
    });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      if (first.kind !== "input_required" || !first.requestState) throw new Error("expected continuation");
      await gateway.continue(context, first.requestState);
      expect(requests[1].requestState).toBe("normalized-state");
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-R05] keeps normalized absent upstream state absent on continuation", async () => {
    const requests: Array<{ requestState?: string }> = [];
    let call = 0;
    const gateway = createGateway({
      continuationKey: key(),
      descriptors: [descriptor()],
      upstream: {
        invoke: async (input) => {
          requests.push(input.request);
          call += 1;
          return call === 1
            ? { kind: "input_required", inputRequests: [], upstreamState: { present: false } }
            : response({ resultType: "complete", value: "done" });
        }
      }
    });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      if (first.kind !== "input_required" || !first.requestState) throw new Error("expected continuation");
      await gateway.continue(context, first.requestState);
      expect(Object.hasOwn(requests[1], "requestState")).toBe(false);
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-R02] [CASE-R06] binds continuation to subject and route and enforces one-time replay for effects", async () => {
    const upstream = new QueueUpstream([response({ resultType: "input_required", inputRequests: [] }), response({ resultType: "complete", value: "done" })]);
    const writeDescriptor = descriptor({ publicName: "write", route: { ...descriptor().route, logicalRoute: "write", effectClass: "safe_write" } });
    const gateway = createGateway({ upstream, continuationKey: key(), descriptors: [writeDescriptor] });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "write", method: "tools/call", params: { name: "write" } });
      if (first.kind !== "input_required" || !first.requestState) throw new Error("expected continuation");
      expect(await gateway.continue({ ...context, principal: "other" }, first.requestState)).toMatchObject({ kind: "failure", code: "continuation_subject_mismatch" });
      expect(await gateway.continue(context, first.requestState)).toMatchObject({ kind: "complete" });
      expect(await gateway.continue(context, first.requestState)).toMatchObject({ kind: "failure", code: "continuation_replayed" });
    } finally {
      await gateway.close();
    }
  });

  it("supports key rotation without exposing plaintext state", () => {
    const oldKey = key();
    const nextKey = new Uint8Array(oldKey.map((value) => value ^ 0xff));
    const oldCodec = createContinuationCodec({ key: oldKey, keyRevision: "old" });
    const token = oldCodec.seal({ generation: 1, tenant: "t", principal: "p", grantRevision: "g", routeRef: "r", endpointIdentity: "e", routeRevision: "v", method: "tools/call", params: { ok: true }, paramsDigest: "digest", upstreamState: { present: false }, effectClass: "read", oneTime: false, issuedAt: Date.now(), expiresAt: Date.now() + 10000 });
    const rotated = createContinuationCodec({ key: nextKey, keyRevision: "new", previousKeys: [oldKey] });
    expect(rotated.open(token).routeRef).toBe("r");
    expect(token).not.toContain("digest");
  });
});
