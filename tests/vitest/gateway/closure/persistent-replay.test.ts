import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContinuationCodec } from "@meshrix/gateway";
import { createSqliteGatewayContinuationLedger } from "@meshrix/foundation/security/gateway-continuation-ledger";
import { context, createTestGateway, descriptor, route } from "../support";

describe("persistent one-time continuation ownership", () => {
  it("[GC-006 GC-008] keeps consumed and unknown claims across process-like key restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-continuation-ledger-"));
    const filePath = join(directory, "continuations.sqlite");
    let clock = 1_000_000;
    const key = randomBytes(32);
    const payload = () => ({ generation: 1, tenant: "synthetic", principal: "caller", grantRevision: "g1", routeRef: "route", endpointIdentity: "endpoint", routeRevision: "r1", method: "tools/call", params: {}, paramsDigest: "p", upstreamState: { present: false }, effectClass: "safe_write" as const, oneTime: true, issuedAt: clock, expiresAt: clock + 60_000 });
    try {
      const firstStore = createSqliteGatewayContinuationLedger({ filePath, now: () => clock, maxEntries: 3 });
      const first = createContinuationCodec({ key, ledger: firstStore, now: () => clock });
      const consumed = first.seal(payload());
      await first.claim(consumed, first.open(consumed));
      await first.settle(consumed, "consumed");
      const uncertain = first.seal(payload());
      await first.claim(uncertain, first.open(uncertain));
      await first.settle(uncertain, "outcome_unknown");
      firstStore.close();

      const reopenedStore = createSqliteGatewayContinuationLedger({ filePath, now: () => clock, maxEntries: 3 });
      const reopened = createContinuationCodec({ key, ledger: reopenedStore, now: () => clock });
      await expect(reopened.claim(consumed, reopened.open(consumed))).rejects.toMatchObject({ code: "continuation_replayed" });
      await expect(reopened.claim(uncertain, reopened.open(uncertain))).rejects.toMatchObject({ code: "continuation_outcome_unknown" });
      const releasable = reopened.seal(payload());
      await reopened.claim(releasable, reopened.open(releasable));
      await reopened.release(releasable);
      await reopened.claim(releasable, reopened.open(releasable));
      await reopened.settle(releasable, "consumed");
      const overCapacity = reopened.seal(payload());
      await expect(reopened.claim(overCapacity, reopened.open(overCapacity))).rejects.toMatchObject({ code: "continuation_capacity" });
      clock += 60_001;
      const afterExpiry = reopened.seal(payload());
      await reopened.claim(afterExpiry, reopened.open(afterExpiry));
      await reopened.settle(afterExpiry, "consumed");
      expect((await stat(filePath)).mode & 0o077).toBe(0);
      reopenedStore.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("[GC-006] atomically admits one claim from twelve independent Node processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-continuation-contention-"));
    const filePath = join(directory, "claims.sqlite");
    const children: ChildProcess[] = [];
    try {
      createSqliteGatewayContinuationLedger({ filePath }).close();
      const program = `import { createSqliteGatewayContinuationLedger } from '@meshrix/foundation/security/gateway-continuation-ledger';
const ledger=createSqliteGatewayContinuationLedger({filePath:process.argv[1]});
try { ledger.claim('synthetic-shared-id', Date.now()+60000); process.stdout.write('claimed'); }
catch(error) { process.stdout.write(String(error.code ?? 'unclassified')); }
finally { ledger.close(); }`;
      const run = () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--conditions=source", "--input-type=module", "-e", program, filePath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error("Synthetic replay contender exited unexpectedly.")));
      });
      const results = await Promise.all(Array.from({ length: 12 }, () => run()));
      expect(results.filter((result) => result === "claimed")).toHaveLength(1);
      expect(results.filter((result) => result === "continuation_in_progress")).toHaveLength(11);
      const ledger = createSqliteGatewayContinuationLedger({ filePath });
      expect(ledger.state("synthetic-shared-id")).toBe("executing");
      ledger.settle("synthetic-shared-id", "outcome_unknown");
      expect(() => ledger.claim("synthetic-shared-id", Date.now() + 60000)).toThrowError(expect.objectContaining({ code: "continuation_outcome_unknown" }));
      ledger.close();
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); })));
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("[GC-008] distinguishes capacity refusal before dispatch from a retained unknown write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-continuation-capacity-"));
    const ledger = createSqliteGatewayContinuationLedger({ filePath: join(directory, "claims.sqlite"), maxEntries: 1 });
    let resumedEffects = 0;
    const gateway = createTestGateway({ continuation: createContinuationCodec({ key: randomBytes(32), ledger }), descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke({ request }) {
        if (!request.requestState) return { status: 200, body: { resultType: "input_required", inputRequests: { confirm: {} }, requestState: "peer-challenge" } };
        resumedEffects += 1;
        throw new Error("synthetic transport loss after dispatch");
      } } });
    await gateway.start();
    try {
      const first = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { id: "first" } });
      const second = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { id: "second" } });
      const firstToken = first.kind === "input_required" ? first.requestState! : "";
      const secondToken = second.kind === "input_required" ? second.requestState! : "";
      expect(await gateway.continue(context, firstToken, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(await gateway.continue(context, secondToken, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_capacity", effectOutcome: "not_started" });
      expect(await gateway.continue(context, firstToken, { confirm: { accepted: true } })).toMatchObject({ kind: "failure", code: "continuation_outcome_unknown" });
      expect(resumedEffects).toBe(1);
    } finally { await gateway.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
