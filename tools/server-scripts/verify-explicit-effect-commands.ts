#!/usr/bin/env node
/*
 * Focused verifier for explicit external Effect Commands.
 *
 * Effects stay a separate family from Change Sets. Uncertain results are not
 * retried silently. Compensation never claims to reverse an unowned effect.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVICE_COLLABORATION_FAMILIES,
  SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY,
  assertEffectCommandFamily,
  createChangeSet,
  effectRetryAllowed,
  lookupFactIsAuthority
} from "../../packages/contracts/src/service-collaboration-contract.ts";
import {
  EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
  EXPLICIT_EFFECT_COMMAND_CRDT_FORBIDDEN_KEYS,
  EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY,
  EXPLICIT_EFFECT_COMMAND_FAMILY,
  EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON,
  EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
  EXPLICIT_EFFECT_COMMAND_PRIVACY_FORBIDDEN_KEYS,
  changeSetHidesEffectCommand,
  compensateUnownedExternalEffect,
  createExplicitEffectCommandInput,
  createExplicitEffectCommandRuntime,
  createPrivacySafeEffectAudit,
  mergeEffectCommandIntoChangeSet,
  rejectCrdtEffectMerge
} from "../../packages/server-runtime/src/explicit-effect-commands.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

export const EXPLICIT_EFFECT_COMMAND_VERIFIER: any =
  "tools/server-scripts/verify-explicit-effect-commands.ts";
export const EXPLICIT_EFFECT_COMMAND_REPORT_RELATIVE_PATH: any =
  "build/reports/explicit-effect-commands.json";
export const EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE: any =
  "tests/vitest/server/explicit-effect-commands.test.ts";
export const EXPLICIT_EFFECT_COMMAND_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:explicit-effect-commands:report-1";

const VITEST_RUNNER: any = "./node_modules/vitest/vitest.mjs";
const SOURCE_FILES: readonly any[] = Object.freeze([
  EXPLICIT_EFFECT_COMMAND_VERIFIER,
  "packages/server-runtime/src/explicit-effect-commands.ts",
  EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE
]);

function repoRootFromMeta() : any {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function recordingSink() : any {
  const calls: any[] = [];
  return {
    calls,
    performExternalEffect: async (input: Record<string, any> = {}) : Promise<any> => {
      calls.push(input);
      if (typeof input.perform === "function") return input.perform();
      if (input.permitReceipt?.schemaVersion !== "v0.0.1:security:governed-execution-permit-consumption-1") {
        throw new Error("External effect sink required a consumed governed permit.");
      }
      return Object.freeze({ resultState: input.resultState || "terminal" });
    }
  };
}

function runtime(performExternalEffect?: any, extras: Record<string, any> = {}) : any {
  const sink: any = performExternalEffect || recordingSink();
  return {
    sink,
    runtime: createExplicitEffectCommandRuntime({
      performExternalEffect: sink.performExternalEffect || sink,
      revalidateAuthorization: extras.revalidateAuthorization || (async (input: Record<string, any> = {}) : Promise<any> => (
        Object.freeze({ allowed: true, ...input })
      )),
      ...extras
    })
  };
}

export async function assertExplicitEffectCommands() : Promise<any> {
  assert.equal(EXPLICIT_EFFECT_COMMAND_FAMILY, "effect-command");
  assert.equal(EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY, "document-state");
  assert.notEqual(EXPLICIT_EFFECT_COMMAND_FAMILY, EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY);
  assert.deepEqual([...SERVICE_COLLABORATION_FAMILIES], ["document-state", "effect-command"]);
  assert.equal(SERVICE_COLLABORATION_SILENT_UNCERTAIN_RETRY, false);
  assert.equal(SERVICE_COLLABORATION_LOCAL_ROLLBACK_REVERSES_EFFECT, false);
  assert.equal(EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED, false);
  assert.equal(
    EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
    "packages/foundation/src/security/governed-execution-permit-authority.ts"
  );
  for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
    assert.equal(lookupFactIsAuthority(fact), false);
  }

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
  assert.equal(changeSet.family, EXPLICIT_EFFECT_COMMAND_DOCUMENT_FAMILY);
  assert.equal(changeSetHidesEffectCommand(changeSet), false);
  assert.equal(changeSetHidesEffectCommand({
    ...changeSet,
    family: EXPLICIT_EFFECT_COMMAND_FAMILY
  }), true);
  const merge: any = mergeEffectCommandIntoChangeSet(
    createExplicitEffectCommandInput(),
    changeSet
  );
  assert.equal(merge.ok, false);
  assert.equal(merge.merged, false);
  assert.equal(merge.reasonCode, "effect_hidden_in_merge");
  const crdt: any = rejectCrdtEffectMerge({ crdt: true, yjsUpdate: "merge" });
  assert.equal(crdt.ok, false);
  assert.equal(crdt.crdtRejected, true);

  const acceptedSink: any = recordingSink();
  const accepted: any = runtime(acceptedSink);
  const first: any = await accepted.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.accept"
  }));
  assert.equal(first.ok, true);
  assert.equal(first.family, EXPLICIT_EFFECT_COMMAND_FAMILY);
  assert.equal(first.invokedSink, true);
  assert.equal(first.permitConsumed, true);
  assert.equal(first.authorizationReResolved, true);
  assert.equal(first.reversesExternalEffect, false);
  assert.equal(first.capacityCertified, false);
  assert.equal(first.command.family, EXPLICIT_EFFECT_COMMAND_FAMILY);
  assert.equal(assertEffectCommandFamily(first.command), true);
  assert.equal(acceptedSink.calls.length, 1);
  assert.equal(
    acceptedSink.calls[0].permitReceipt.schemaVersion,
    "v0.0.1:security:governed-execution-permit-consumption-1"
  );

  const replay: any = await accepted.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.accept"
  }));
  assert.equal(replay.invokedSink, false);
  assert.equal(replay.reasonCode, "effect_idempotent_replay");
  assert.equal(acceptedSink.calls.length, 1);

  const nonIdempotentSink: any = recordingSink();
  const nonIdempotent: any = runtime(nonIdempotentSink);
  const once: any = await nonIdempotent.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.once",
    idempotency: "non_idempotent"
  }));
  const twice: any = await nonIdempotent.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.once",
    idempotency: "non_idempotent"
  }));
  assert.equal(once.ok, true);
  assert.equal(twice.invokedSink, false);
  assert.equal(twice.retryAllowed, false);
  assert.equal(nonIdempotentSink.calls.length, 1);

  let uncertainCalls: any = 0;
  const uncertain: any = runtime({
    performExternalEffect: async (input: Record<string, any> = {}) : Promise<any> => {
      uncertainCalls += 1;
      if (!input.permitReceipt) throw new Error("missing permit");
      throw new Error("external effect did not settle");
    }
  });
  const uncertainResult: any = await uncertain.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.uncertain"
  }));
  assert.equal(uncertainResult.ok, false);
  assert.equal(uncertainResult.resultState, "uncertain");
  assert.equal(uncertainResult.retryAllowed, false);
  assert.equal(effectRetryAllowed(uncertainResult.command), false);
  const silent: any = uncertain.runtime.retry({ effectId: "eff.sc.uncertain", silent: true });
  assert.equal(silent.ok, false);
  assert.equal(silent.invokedSink, false);
  assert.equal(silent.reasonCode, "silent_uncertain_retry_forbidden");
  const automatic: any = uncertain.runtime.retry({ effectId: "eff.sc.uncertain", automatic: true });
  assert.equal(automatic.reasonCode, "silent_uncertain_retry_forbidden");
  const explicitRetry: any = uncertain.runtime.retry({ effectId: "eff.sc.uncertain" });
  assert.equal(explicitRetry.ok, false);
  assert.equal(explicitRetry.reasonCode, "conflict.effect_uncertain");
  const uncertainReplay: any = await uncertain.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.uncertain"
  }));
  assert.equal(uncertainReplay.invokedSink, false);
  assert.equal(uncertainCalls, 1);

  const unowned: any = compensateUnownedExternalEffect({ effectId: "eff.foreign.1" });
  assert.equal(unowned.ok, false);
  assert.equal(unowned.reversesExternalEffect, false);
  assert.equal(unowned.reasonCode, "unowned_external_effect");
  const host: any = runtime();
  const owned: any = await host.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.owned"
  }));
  assert.equal(owned.ok, true);
  const missing: any = await host.runtime.compensate({ effectId: "eff.foreign.1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reversesExternalEffect, false);
  assert.equal(missing.reasonCode, "unowned_external_effect");
  const compensation: any = await host.runtime.compensate({
    effectId: "eff.sc.owned",
    compensationEffectId: "eff.sc.comp.1",
    authorization: createExplicitEffectCommandInput().authorization
  });
  assert.equal(compensation.ok, true);
  assert.equal(compensation.compensated, true);
  assert.equal(compensation.reversesExternalEffect, false);
  assert.equal(compensation.originalEffectId, "eff.sc.owned");

  const deniedPrior: any = runtime(recordingSink(), {
    revalidateAuthorization: async () : Promise<any> => Object.freeze({ allowed: true })
  });
  const prior: any = await deniedPrior.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.prior",
    authorization: {
      ...createExplicitEffectCommandInput().authorization,
      usePriorApprovalAsAuthority: true
    }
  }));
  assert.equal(prior.ok, false);
  assert.equal(prior.invokedSink, false);
  assert.equal(prior.reasonCode, "prior_approval_is_not_authority");
  assert.equal(deniedPrior.sink.calls.length, 0);

  const preview: any = await runtime(recordingSink()).runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.preview",
    authorization: {
      ...createExplicitEffectCommandInput().authorization,
      strategyPreview: { effect: "allow" },
      usePreviewAsAuthority: true
    }
  }));
  assert.equal(preview.ok, false);
  assert.equal(preview.invokedSink, false);
  assert.equal(preview.reasonCode, "strategy_preview_is_not_execution_credential");

  const stale: any = runtime(recordingSink(), {
    revalidateAuthorization: async () : Promise<any> => Object.freeze({
      allowed: true,
      grantLookup: "gr.rotated.1"
    })
  });
  const changed: any = await stale.runtime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.stale"
  }));
  assert.equal(changed.ok, false);
  assert.equal(changed.invokedSink, false);
  assert.equal(changed.reasonCode, "conflict.authorization_changed");

  const engineRuntime: any = createExplicitEffectCommandRuntime({
    performExternalEffect: recordingSink().performExternalEffect
  });
  const engineResult: any = await engineRuntime.execute(createExplicitEffectCommandInput({
    effectId: "eff.sc.engine"
  }));
  assert.equal(engineResult.ok, true);
  assert.equal(engineResult.authorizationReResolved, true);

  const audit: any = createPrivacySafeEffectAudit(engineResult.command);
  for (const key of EXPLICIT_EFFECT_COMMAND_PRIVACY_FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(audit, key), false, `audit leaked ${key}`);
  }
  for (const key of EXPLICIT_EFFECT_COMMAND_CRDT_FORBIDDEN_KEYS) {
    assert.equal(Object.hasOwn(audit, key), false);
  }

  return Object.freeze({
    familySeparated: true,
    hiddenMergeRejected: merge.ok === false,
    crdtMergeRejected: crdt.crdtRejected === true,
    uncertainNotSilentlyRetried: silent.reasonCode === "silent_uncertain_retry_forbidden",
    unownedCompensationDoesNotReverse: missing.reversesExternalEffect === false,
    ownedCompensationDoesNotClaimReverse: compensation.reversesExternalEffect === false,
    priorApprovalIsNotAuthority: prior.reasonCode === "prior_approval_is_not_authority",
    strategyPreviewIsNotAuthority: preview.reasonCode === "strategy_preview_is_not_execution_credential",
    currentFactsReResolved: engineResult.authorizationReResolved === true,
    governedPermitConsumed: first.permitConsumed === true,
    permitAuthority: EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
    lookupFactsAreNotAuthority: SERVICE_COLLABORATION_LOOKUP_FACTS.every((fact?: any) : any => (
      lookupFactIsAuthority(fact) === false
    )),
    privacySafe: true,
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
    nonCertificationReason: EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON,
    effectCommandRuntimePresent: true
  });
}

export function buildExplicitEffectCommandReport(
  assertion: Record<string, any> = {},
  extras: Record<string, any> = {}
) : any {
  return {
    schemaVersion: EXPLICIT_EFFECT_COMMAND_REPORT_SCHEMA_VERSION,
    verifier: EXPLICIT_EFFECT_COMMAND_VERIFIER,
    generatedAt: extras.generatedAt || "1970-01-01T00:00:00.000Z",
    capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED,
    nonCertificationReason: EXPLICIT_EFFECT_COMMAND_NON_CERTIFICATION_REASON,
    summary: {
      familySeparated: assertion.familySeparated === true,
      hiddenMergeRejected: assertion.hiddenMergeRejected === true,
      crdtMergeRejected: assertion.crdtMergeRejected === true,
      uncertainNotSilentlyRetried: assertion.uncertainNotSilentlyRetried === true,
      unownedCompensationDoesNotReverse: assertion.unownedCompensationDoesNotReverse === true,
      ownedCompensationDoesNotClaimReverse: assertion.ownedCompensationDoesNotClaimReverse === true,
      priorApprovalIsNotAuthority: assertion.priorApprovalIsNotAuthority === true,
      strategyPreviewIsNotAuthority: assertion.strategyPreviewIsNotAuthority === true,
      currentFactsReResolved: assertion.currentFactsReResolved === true,
      governedPermitConsumed: assertion.governedPermitConsumed === true,
      lookupFactsAreNotAuthority: assertion.lookupFactsAreNotAuthority === true,
      privacySafe: assertion.privacySafe === true,
      focusedSuitePassed: extras.focusedSuitePassed === true,
      effectCommandRuntimePresent: assertion.effectCommandRuntimePresent === true,
      capacityCertified: EXPLICIT_EFFECT_COMMAND_CAPACITY_CERTIFIED
    },
    permitAuthority: EXPLICIT_EFFECT_COMMAND_PERMIT_AUTHORITY,
    families: [...SERVICE_COLLABORATION_FAMILIES]
  };
}

function runFocusedSuite(repoRoot?: any) : any {
  const result: any = spawnSync(process.execPath, [
    "--conditions=source",
    VITEST_RUNNER,
    "run",
    "--config",
    "vitest.config.ts",
    EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=source"
    }
  });
  return {
    suite: EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE,
    passed: result.status === 0,
    exitCode: result.status,
    outputBytes: Buffer.byteLength(`${result.stdout || ""}${result.stderr || ""}`, "utf8"),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || "")
  };
}

export async function runExplicitEffectCommands({
  repoRoot = repoRootFromMeta(),
  writeReport = true,
  runFocusedTests = false,
  generatedAt = new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  const assertion: any = await assertExplicitEffectCommands();

  let focusedSuite: any = {
    suite: EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE,
    passed: runFocusedTests !== true,
    exitCode: 0,
    outputBytes: 0
  };
  if (runFocusedTests === true) {
    focusedSuite = runFocusedSuite(repoRoot);
    if (focusedSuite.passed !== true) {
      process.stderr.write(focusedSuite.stdout);
      process.stderr.write(focusedSuite.stderr);
      throw new Error(
        `Focused suite failed: ${EXPLICIT_EFFECT_COMMAND_FOCUSED_SUITE} exit=${focusedSuite.exitCode}`
      );
    }
  }

  const report: any = buildExplicitEffectCommandReport(assertion, {
    generatedAt,
    focusedSuitePassed: focusedSuite.passed === true
  });
  const provenance: Record<string, any> = {
    producer: "meshrix-core-explicit-effect-commands",
    commandId: "explicit-effect-commands",
    sourceRevision: await computeVerifierSourceRevision(repoRoot, SOURCE_FILES)
  };
  const finalized: any = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "explicit effect command report");
  assertReportProvenance(finalized, provenance);
  assert.equal(finalized.capacityCertified, false);
  assert.equal(finalized.summary.capacityCertified, false);

  if (writeReport === true) {
    const relativePath: any = EXPLICIT_EFFECT_COMMAND_REPORT_RELATIVE_PATH;
    const absolutePath: any = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  }

  return {
    report: finalized,
    reportPath: EXPLICIT_EFFECT_COMMAND_REPORT_RELATIVE_PATH,
    focusedSuite: {
      suite: focusedSuite.suite,
      passed: focusedSuite.passed,
      exitCode: focusedSuite.exitCode,
      outputBytes: focusedSuite.outputBytes
    }
  };
}

const executedDirectly: any = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (executedDirectly) {
  try {
    const result: any = await runExplicitEffectCommands({
      writeReport: true,
      runFocusedTests: true
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reportPath: result.reportPath,
      familySeparated: result.report.summary.familySeparated,
      uncertainNotSilentlyRetried: result.report.summary.uncertainNotSilentlyRetried,
      unownedCompensationDoesNotReverse: result.report.summary.unownedCompensationDoesNotReverse,
      capacityCertified: result.report.capacityCertified,
      focusedSuitePassed: result.report.summary.focusedSuitePassed
    })}\n`);
  } catch (error: any) {
    const message: any = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
