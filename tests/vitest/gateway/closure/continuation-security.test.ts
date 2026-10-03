import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createContinuationCodec } from "@meshrix/gateway";
import { context, createTestGateway, descriptor, key, route } from "../support";

const now = 1_000_000;

function fixture() {
  const codec = createContinuationCodec({ key: randomBytes(32), now: () => now });
  const token = codec.seal({ generation: 1, tenant: "synthetic", principal: "caller", grantRevision: "g1", routeRef: "route", endpointIdentity: "endpoint", routeRevision: "r1", method: "tools/call", params: { name: "write" }, paramsDigest: "input", upstreamState: { present: false }, effectClass: "safe_write", oneTime: true, issuedAt: now, expiresAt: now + 60_000 });
  return { codec, token };
}

describe("PR82 continuation identity and consumption", () => {
  it("[GC-003 GC-004] rejects equivalent encodings and consumed replay", async () => {
    const { codec, token } = fixture();
    expect(() => codec.open(`${token}=`)).toThrowError(expect.objectContaining({ code: "continuation_invalid" }));
    const payload = codec.open(token);
    await codec.claim(token, payload);
    await codec.settle(token, "consumed");
    await expect(codec.claim(token, codec.open(token))).rejects.toMatchObject({ code: "continuation_replayed" });
  });

  it("[GC-005] claims once across concurrent presentations", async () => {
    const { codec, token } = fixture();
    const payload = codec.open(token);
    expect(payload.principal).toBe("caller");
    // Caller identity is verified at the gateway boundary before claim; the codec cannot infer a caller.
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => codec.claim(token, payload)));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(19);
  });

  it("[GC-008] releases only pre-effect executing claims and preserves unknown", async () => {
    const { codec, token } = fixture();
    const payload = codec.open(token);
    await codec.claim(token, payload);
    await codec.release(token);
    await codec.claim(token, payload);
    await codec.settle(token, "outcome_unknown");
    await codec.release(token);
    await expect(codec.claim(token, payload)).rejects.toMatchObject({ code: "continuation_outcome_unknown" });
  });

  it("[GC-006] a restarted ephemeral profile never reissues a one-time effect", async () => {
    const key = randomBytes(32);
    const first = createContinuationCodec({ key, now: () => now });
    const token = first.seal({ generation: 1, tenant: "synthetic", principal: "caller", grantRevision: "g1", routeRef: "route", endpointIdentity: "endpoint", routeRevision: "r1", method: "tools/call", params: {}, paramsDigest: "p", upstreamState: { present: false }, effectClass: "safe_write", oneTime: true, issuedAt: now, expiresAt: now + 60_000 });
    const restarted = createContinuationCodec({ key, now: () => now });
    expect(() => restarted.open(token)).toThrowError(expect.objectContaining({ code: "continuation_epoch_expired" }));
  });

  it("[GC-007] wrong tenant presentation cannot claim the rightful subject's continuation", async () => {
    let calls = 0;
    const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke() { calls += 1; return calls === 1
        ? { status: 200, body: { resultType: "input_required", inputRequests: { confirm: {} }, requestState: "peer-state" } }
        : { status: 200, body: { resultType: "complete", content: [{ type: "text", text: "accepted" }] } }; } } });
    await gateway.start();
    try {
      const initial = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(initial.kind).toBe("input_required");
      const token = initial.kind === "input_required" ? initial.requestState! : "";
      expect(await gateway.continue({ ...context, tenant: "other" }, token, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_subject_mismatch" });
      expect(calls).toBe(1);
      expect(await gateway.continue(context, token, { confirm: { accepted: true } })).toMatchObject({ kind: "complete" });
      expect(calls).toBe(2);
    } finally { await gateway.close(); }
  });

  it("[GC-008] a peer disconnect after dispatch preserves the unknown effect and forbids replay", async () => {
    let calls = 0;
    const gateway = createTestGateway({
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      continuationKey: key(),
      upstream: { async invoke() {
        calls += 1;
        if (calls === 1) return { status: 200, body: { resultType: "input_required", inputRequests: { confirm: { required: true } }, requestState: "peer-state" } };
        throw new Error("synthetic disconnect after send");
      } }
    });
    await gateway.start();
    try {
      const initial = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { arguments: {} } });
      expect(initial.kind).toBe("input_required");
      const token = initial.kind === "input_required" ? initial.requestState! : "";
      expect(await gateway.continue(context, token, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(await gateway.continue(context, token, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_outcome_unknown" });
      expect(calls).toBe(2);
    } finally { await gateway.close(); }
  });

  it("[GC-003] finalizes a claimed in-flight effect even when its token expires during dispatch", async () => {
    let clock = now;
    const codec = createContinuationCodec({ key: randomBytes(32), now: () => clock, ttlMs: 1000 });
    const token = codec.seal({ generation: 1, tenant: "synthetic", principal: "caller", grantRevision: "g1", routeRef: "route", endpointIdentity: "endpoint", routeRevision: "r1", method: "tools/call", params: {}, paramsDigest: "p", upstreamState: { present: false }, effectClass: "safe_write", oneTime: true, issuedAt: clock, expiresAt: clock + 1000 });
    await codec.claim(token, codec.open(token));
    clock += 1001;
    await codec.settle(token, "outcome_unknown");
    expect(codec.state(token)).toBe("outcome_unknown");
    expect(() => codec.open(token)).toThrowError(expect.objectContaining({ code: "continuation_expired" }));
  });

  it("[GC-003 GC-004 GC-005] permits one peer effect across replay, alternate spelling and 20 concurrent claims", async () => {
    let writes = 0;
    const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke({ request }) {
        if (!request.requestState) return { status: 200, body: { resultType: "input_required", inputRequests: { confirm: {} }, requestState: "synthetic-peer-state" } };
        writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 200, body: { resultType: "complete", content: [{ type: "text", text: "effect-committed" }] } };
      } } });
    await gateway.start();
    try {
      const initial = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      const token = initial.kind === "input_required" ? initial.requestState! : "";
      const parts = token.split(".");
      const nonCanonical = [...parts.slice(0, 2), `${parts[2]}=`, ...parts.slice(3)].join(".");
      expect(await gateway.continue(context, nonCanonical, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_invalid" });
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => gateway.continue(context, token, { confirm: { accepted: true } })));
      expect(outcomes.filter((outcome) => outcome.kind === "complete")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === "failure")).toHaveLength(19);
      expect(await gateway.continue(context, token, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_replayed" });
      expect(writes).toBe(1);
    } finally { await gateway.close(); }
  });
});
