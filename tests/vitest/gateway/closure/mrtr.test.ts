import { describe, expect, it } from "vitest";
import { context, createTestGateway, descriptor, key, route } from "../support";

describe("standard multi-round input continuation", () => {
  it("[GC-017 GC-018] round-trips absent, empty and nonempty upstream state through real peer invocations", async () => {
    for (const upstreamState of [undefined, "", "opaque-state"] as const) {
      const requests: Array<{ requestState?: string; params: unknown }> = [];
      const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ effectClass: "read" }) })],
        upstream: { async invoke({ request }) {
          requests.push(request);
          return requests.length === 1
            ? { status: 200, body: upstreamState === undefined ? { resultType: "input_required", inputRequests: { confirm: {} } } : { resultType: "input_required", requestState: upstreamState } }
            : { status: 200, body: { resultType: "complete", content: [{ type: "text", text: JSON.stringify((request.params as { inputResponses: unknown }).inputResponses) }] } };
        } } });
      await gateway.start();
      try {
        const initial = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { name: "job" } });
        expect(initial.kind).toBe("input_required");
        const result = await gateway.continue(context, initial.kind === "input_required" ? initial.requestState! : "", { confirm: { accepted: true } });
        expect(result).toMatchObject({ kind: "complete", value: { content: [{ text: '{"confirm":{"accepted":true}}' }] } });
        expect(Object.hasOwn(requests[1], "requestState")).toBe(upstreamState !== undefined);
        if (upstreamState !== undefined) expect(requests[1].requestState).toBe(upstreamState);
      } finally { await gateway.close(); }
    }
  });

  it("[GC-016 GC-019] sends the keyed answer to the peer, rejects a forged route, then accepts the original route", async () => {
    const observed: unknown[] = [];
    const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ logicalRoute: "first", effectClass: "read" }) }), descriptor({ route: route({ logicalRoute: "other", effectClass: "read" }) })],
      upstream: { async invoke({ request }) {
        observed.push(request);
        const params = request.params as { inputResponses?: Record<string, unknown> };
        return { status: 200, body: params.inputResponses?.confirm
          ? { resultType: "complete", content: [{ type: "text", text: JSON.stringify(params.inputResponses.confirm) }] }
          : { resultType: "input_required", inputRequests: { confirm: { required: true } }, requestState: "peer-state" } };
      } } });
    await gateway.start();
    try {
      const initial = await gateway.invoke(context, { routeRef: "first", method: "tools/call", params: { name: "first", arguments: { value: 7 } } });
      expect(initial.kind).toBe("input_required");
      const token = initial.kind === "input_required" ? initial.requestState! : "";
      expect(await gateway.invoke(context, { routeRef: "other", method: "tools/call", params: { name: "other", arguments: { value: 8 } }, requestState: token, inputResponses: { confirm: { answer: 42 } } })).toMatchObject({ kind: "failure", code: "continuation_request_mismatch" });
      expect(observed).toHaveLength(1);
      const completed = await gateway.invoke(context, { routeRef: "first", method: "tools/call", params: { name: "first", arguments: { value: 7 }, requestState: token, inputResponses: { confirm: { answer: 42 } } }, requestState: token, inputResponses: { confirm: { answer: 42 } } });
      expect(completed).toMatchObject({ kind: "complete", value: { content: [{ text: '{"answer":42}' }] } });
      expect((observed[1] as { params: unknown }).params).toMatchObject({ inputResponses: { confirm: { answer: 42 } } });
    } finally { await gateway.close(); }
  });

  it("[GC-020] propagates the second-round abort and does not replay an uncertain write", async () => {
    let sent = 0;
    let aborted = 0;
    const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke({ signal }) {
        sent += 1;
        if (sent <= 2) return { status: 200, body: { resultType: "input_required", inputRequests: { confirm: { required: true } }, requestState: `round-${sent}` } };
        return new Promise((_resolve, reject) => {
          const cancelled = () => { aborted += 1; reject(Object.assign(new Error("peer cancelled"), { name: "AbortError" })); };
          if (signal?.aborted) cancelled();
          else signal?.addEventListener("abort", cancelled, { once: true });
        });
      } } });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      const second = await gateway.continue(context, first.kind === "input_required" ? first.requestState! : "", { confirm: { answer: 1 } });
      expect(second.kind).toBe("input_required");
      const token = second.kind === "input_required" ? second.requestState! : "";
      const signal = new AbortController();
      const pending = gateway.continue(context, token, { confirm: { answer: 2 } }, signal.signal);
      for (let attempt = 0; sent !== 3 && attempt < 100; attempt++) await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toBe(3);
      signal.abort();
      expect(await pending).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(aborted).toBe(1);
      expect(await gateway.continue(context, token, { confirm: { answer: 2 } })).toMatchObject({ kind: "failure", code: "continuation_outcome_unknown" });
      expect(gateway.stats()).toMatchObject({ activeInvocations: 0, admission: { active: 0, queued: 0 } });
    } finally { await gateway.close(); }
  }, 10_000);

  it("[GC-022] keeps two business contexts isolated when per-hop client capabilities change", async () => {
    const sent: Array<{ state?: string; params: any }> = [];
    const gateway = createTestGateway({ continuationKey: key(), descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke({ request }) {
        const params = request.params as { arguments?: { id: string }; inputResponses?: Record<string, unknown> };
        sent.push({ state: request.requestState, params });
        return { status: 200, body: params.inputResponses && Object.hasOwn(params.inputResponses, "confirm")
          ? { resultType: "complete", content: [{ type: "text", text: `${params.arguments?.id}:${request.requestState}` }] }
          : { resultType: "input_required", inputRequests: { confirm: {} }, requestState: `state-${params.arguments?.id}` } };
      } } });
    await gateway.start();
    const a = { ...context, principal: "subject-a" };
    const b = { ...context, principal: "subject-b" };
    try {
      const contextA = gateway.createContext({ tenant: a.tenant, principal: a.principal, grantRevision: "grant-1", credentialGeneration: "auth-1", routeRef: "route.demo" });
      const contextB = gateway.createContext({ tenant: b.tenant, principal: b.principal, grantRevision: "grant-1", credentialGeneration: "auth-1", routeRef: "route.demo" });
      const initial = (id: string, handle: string) => ({ routeRef: "route.demo", method: "tools/call", contextHandle: handle, params: { name: "job", arguments: { id }, _meta: { "io.modelcontextprotocol/clientCapabilities": { version: 1 } } } });
      const firstA = await gateway.invoke(a, initial("A", contextA.handle));
      const firstB = await gateway.invoke(b, initial("B", contextB.handle));
      expect(firstA.kind).toBe("input_required");
      expect(firstB.kind).toBe("input_required");
      const tokenA = firstA.kind === "input_required" ? firstA.requestState! : "";
      const tokenB = firstB.kind === "input_required" ? firstB.requestState! : "";
      expect(await gateway.continue(a, tokenB, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_subject_mismatch" });
      const resumed = (id: string, handle: string, token: string, answers: Record<string, unknown> = { confirm: { accepted: true } }) => ({ routeRef: "route.demo", method: "tools/call", contextHandle: handle, requestState: token, inputResponses: answers,
        params: { name: "job", arguments: { id }, _meta: { "io.modelcontextprotocol/clientCapabilities": { version: 2 } }, requestState: token, inputResponses: answers } });
      const repeatedA = await gateway.invoke(a, resumed("A", contextA.handle, tokenA, {}));
      expect(repeatedA.kind).toBe("input_required");
      const tokenA2 = repeatedA.kind === "input_required" ? repeatedA.requestState! : "";
      expect(await gateway.invoke(b, resumed("B", contextB.handle, tokenB))).toMatchObject({ kind: "complete", value: { content: [{ text: "B:state-B" }] } });
      expect(await gateway.invoke(a, resumed("A", contextA.handle, tokenA2))).toMatchObject({ kind: "complete", value: { content: [{ text: "A:state-A" }] } });
      expect(sent.map((entry) => entry.state)).toEqual([undefined, undefined, "state-A", "state-B", "state-A"]);
    } finally { await gateway.close(); }
  });
});
