import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  createChangeSet,
  effectRetryAllowed,
  lookupFactIsAuthority
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
  EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY,
  EXPLICIT_EFFECT_COMMAND_FAMILY,
  EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON,
  EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
  changeSetHidesEffectCommand,
  compensateUnownedExternalEffect,
  createExplicitEffectCommandInput,
  createExplicitEffectCommandRuntime,
  createPrivacySafeEffectAudit,
  mergeEffectCommandIntoChangeSet,
  rejectCrdtEffectMerge
} from "../../../packages/server-runtime/src/explicit-effect-commands.ts";
import {
  EXPLICIT_EFFECT_COMMAND_REPORT_RELATIVE_PATH,
  EXPLICIT_EFFECT_COMMAND_VERIFIER,
  assertExplicitEffectCommands,
  buildExplicitEffectCommandReport
} from "../../../tools/server-scripts/verify-explicit-effect-commands.ts";

const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

function sink(resultState: any = "terminal") : any {
  const calls: any[] = [];
  return {
    calls,
    performExternalEffect: async (input: Record<string, any> = {}) : Promise<any> => {
      calls.push(input);
      if (!input.permitReceipt) throw new Error("missing governed permit");
      return Object.freeze({ resultState });
    }
  };
}

function commands(performExternalEffect?: any, extras: Record<string, any> = {}) : any {
  const recorded: any = performExternalEffect || sink();
  return {
    recorded,
    runtime: createExplicitEffectCommandRuntime({
      performExternalEffect: recorded.performExternalEffect || recorded,
      revalidateAuthorization: extras.revalidateAuthorization || (async (input: Record<string, any> = {}) : Promise<any> => (
        Object.freeze({ allowed: true, ...input })
      )),
      ...extras
    })
  };
}

describe("explicit external Effect Commands", () : any => {
  it("keeps Effect Commands as a separate family from Change Sets", () : any => {
    const changeSet: any = createChangeSet({
      changeId: "chg.sc.1",
      baselineHead: 4,
      operations: [{
        opId: "op.sc.1",
        type: "insert",
        entityId: "ent.sc.a",
        index: 1,
        relevantIndexes: [1],
        payloadDigest: "sha256:abababababababababababababababababababababababababababababababab"
      }],
      attributionRef: "attr.sc.1"
    });
    expect(EXPLICIT_EFFECT_COMMAND_FAMILY).toBe("effect-command");
    expect(changeSet.family).toBe(EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY);
    expect(changeSetHidesEffectCommand(changeSet)).toBe(false);
    expect(mergeEffectCommandIntoChangeSet(createExplicitEffectCommandInput(), changeSet)).toMatchObject({
      ok: false,
      merged: false,
      reasonCode: "effect_hidden_in_merge"
    });
    expect(rejectCrdtEffectMerge({ automerge: true }).crdtRejected).toBe(true);
  });

  it("re-resolves current authorization and consumes the governed permit before the sink", async () : Promise<any> => {
    const recorded: any = sink();
    const { runtime } = commands(recorded);
    const result: any = await runtime.execute(createExplicitEffectCommandInput({ effectId: "eff.sc.bind" }));
    expect(result.ok).toBe(true);
    expect(result.authorizationReResolved).toBe(true);
    expect(result.permitConsumed).toBe(true);
    expect(result.invokedSink).toBe(true);
    expect(result.command.family).toBe(EXPLICIT_EFFECT_COMMAND_FAMILY);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0].permitReceipt.schemaVersion).toBe(
      "v0.0.1:security:governed-execution-permit-consumption-1"
    );
    expect(EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY).toBe(
      "packages/foundation/src/security/governed-execution-permit-authority.ts"
    );
  });

  it("does not treat prior approval, lookup facts, or strategy preview as authority", async () : Promise<any> => {
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
    const recorded: any = sink();
    const { runtime } = commands(recorded);
    const prior: any = await runtime.execute(createExplicitEffectCommandInput({
      effectId: "eff.sc.prior",
      authorization: {
        ...createExplicitEffectCommandInput().authorization,
        usePriorApprovalAsAuthority: true
      }
    }));
    const preview: any = await runtime.execute(createExplicitEffectCommandInput({
      effectId: "eff.sc.preview",
      authorization: {
        ...createExplicitEffectCommandInput().authorization,
        strategyPreview: { effect: "allow" },
        usePreviewAsAuthority: true
      }
    }));
    expect(prior).toMatchObject({
      ok: false,
      invokedSink: false,
      reasonCode: "prior_approval_is_not_authority"
    });
    expect(preview).toMatchObject({
      ok: false,
      invokedSink: false,
      reasonCode: "strategy_preview_is_not_execution_credential"
    });
    expect(recorded.calls).toHaveLength(0);
  });

  it("does not retry uncertain results silently and does not reverse unowned effects", async () : Promise<any> => {
    let calls: any = 0;
    const { runtime } = commands({
      performExternalEffect: async () : Promise<any> => {
        calls += 1;
        throw new Error("external effect did not settle");
      }
    });
    const uncertain: any = await runtime.execute(createExplicitEffectCommandInput({
      effectId: "eff.sc.uncertain"
    }));
    expect(uncertain.resultState).toBe("uncertain");
    expect(effectRetryAllowed(uncertain.command)).toBe(false);
    expect(runtime.retry({ effectId: "eff.sc.uncertain", silent: true }).reasonCode).toBe(
      "silent_uncertain_retry_forbidden"
    );
    expect(await runtime.execute(createExplicitEffectCommandInput({ effectId: "eff.sc.uncertain" }))).toMatchObject({
      invokedSink: false,
      retryAllowed: false
    });
    expect(calls).toBe(1);
    expect(compensateUnownedExternalEffect({ effectId: "eff.foreign.1" })).toMatchObject({
      ok: false,
      reversesExternalEffect: false,
      reasonCode: "unowned_external_effect"
    });
    expect(await runtime.compensate({ effectId: "eff.foreign.1" })).toMatchObject({
      ok: false,
      reversesExternalEffect: false,
      reasonCode: "unowned_external_effect"
    });
  });

  it("issues owned compensation without claiming to reverse the original external effect", async () : Promise<any> => {
    const { runtime } = commands();
    await runtime.execute(createExplicitEffectCommandInput({ effectId: "eff.sc.owned" }));
    const compensation: any = await runtime.compensate({
      effectId: "eff.sc.owned",
      compensationEffectId: "eff.sc.comp.1",
      authorization: createExplicitEffectCommandInput().authorization
    });
    expect(compensation.compensated).toBe(true);
    expect(compensation.reversesExternalEffect).toBe(false);
    expect(compensation.originalEffectId).toBe("eff.sc.owned");
    expect(createPrivacySafeEffectAudit(compensation.command)).toMatchObject({
      family: EXPLICIT_EFFECT_COMMAND_FAMILY,
      reversesExternalEffect: false,
      capacityCertified: false
    });
  });

  it("writes a privacy-safe report that never certifies capacity", async () : Promise<any> => {
    const assertion: any = await assertExplicitEffectCommands();
    const report: any = buildExplicitEffectCommandReport(assertion, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    expect(assertion.capacityCertified).toBe(false);
    expect(report.capacityCertified).toBe(EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED);
    expect(report.nonCertificationReason).toBe(EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON);
    expect(report.verifier).toBe(EXPLICIT_EFFECT_COMMAND_VERIFIER);
    expect(report.summary.effectCommandRuntimePresent).toBe(true);
    expect(EXPLICIT_EFFECT_COMMAND_REPORT_RELATIVE_PATH).toBe("build/reports/explicit-effect-commands.json");
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(ABSOLUTE_PATH_PATTERN);
  });
});
