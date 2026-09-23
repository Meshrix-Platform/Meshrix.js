import { describe, expect, it } from "vitest";
import { context, createTestGateway, descriptor, route } from "../support";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { createSqliteGatewayContinuationLedger } from "@meshrix/foundation/security/gateway-continuation-ledger";

describe("query-only uncertain execution receipt", () => {
  it("[GC-051] returns a scoped stable receipt for an unknown write without dispatching a query as a second effect", async () => {
    let sends = 0;
    const original = descriptor({ route: route({ effectClass: "safe_write" }) });
    const gateway = createTestGateway({ descriptors: [original], upstream: { async invoke() { sends += 1; throw new Error("synthetic disconnect after dispatch"); } } });
    await gateway.start();
    try {
      const result = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(result).toMatchObject({ kind: "failure", effectOutcome: "unknown", details: { receiptId: expect.any(String) } });
      const receiptId = result.kind === "failure" ? String(result.details?.receiptId) : "";
      expect(await gateway.receiptStatus(context, receiptId)).toMatchObject({ receiptId, state: "outcome_unknown" });
      expect(await gateway.receiptStatus({ ...context, principal: "other" }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(await gateway.receiptStatus({ ...context, grant: { ...context.grant, revoked: true } }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(sends).toBe(1);
      gateway.publishCatalog([{ ...original, route: { ...original.route, endpointIdentity: "rotated", revision: "rotated" } }]);
      expect(await gateway.receiptStatus(context, receiptId)).toMatchObject({ kind: "failure", code: "receipt_target_changed" });
      expect(sends).toBe(1);
    } finally { await gateway.close(); }
  });

  it("[GC-051] retains a scoped unknown receipt across an owned durable profile restart without a second peer effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-durable-receipt-"));
    const filePath = join(directory, "claims.sqlite");
    const declaration = descriptor({ route: route({ effectClass: "safe_write" }) });
    let peerEffects = 0;
    const firstLedger = createSqliteGatewayContinuationLedger({ filePath });
    const first = createTestGateway({ descriptors: [declaration], permits: createGatewayPermitAuthority({ receiptLedger: firstLedger }),
      upstream: { async invoke() { peerEffects += 1; throw new Error("synthetic peer response disappeared after dispatch"); } } });
    let second: ReturnType<typeof createTestGateway> | undefined;
    let reopened: ReturnType<typeof createSqliteGatewayContinuationLedger> | undefined;
    try {
      await first.start();
      const uncertain = await first.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(uncertain).toMatchObject({ kind: "failure", effectOutcome: "unknown", details: { receiptId: expect.any(String) } });
      const receiptId = uncertain.kind === "failure" ? String(uncertain.details?.receiptId) : "";
      expect(peerEffects).toBe(1);
      await first.close();
      firstLedger.close();

      reopened = createSqliteGatewayContinuationLedger({ filePath });
      const newAuthority = createGatewayPermitAuthority({ receiptLedger: reopened });
      second = createTestGateway({ descriptors: [declaration], permits: newAuthority,
        upstream: { async invoke() { peerEffects += 1; throw new Error("query must never dispatch"); } } });
      await second.start();
      expect(await second.receiptStatus(context, receiptId)).toMatchObject({ receiptId, state: "outcome_unknown" });
      expect(await second.receiptStatus({ ...context, principal: "other" }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(() => newAuthority.consume({ permit: reopened!.lookupReceipt(receiptId)!, context, prepared: {} as never })).toThrowError(expect.objectContaining({ code: "permit_replayed" }));
      expect(peerEffects).toBe(1);
    } finally {
      await first.close();
      await second?.close();
      firstLedger.close();
      reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
