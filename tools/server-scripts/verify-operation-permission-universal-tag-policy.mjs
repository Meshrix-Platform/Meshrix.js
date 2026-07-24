#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  evaluateUniversalTagPolicy
} from "../../packages/foundation/src/security/authorization/universal-tag-policy.mjs";
import {
  createSecurityPermissionsProvider
} from "../../packages/foundation/src/security/security-permissions-provider.mjs";
import { createTagStoreAdapter } from "../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

const REPORT_PATH = "build/reports/operation-permission-universal-tag-policy.json";
const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders|\/tmp\//u],
  ["bearer_token", /Bearer\s+(?!\[redacted\])/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{16,}\b|xox[baprs]-[A-Za-z0-9-]{16,}/u],
  ["runtime_id", /tool_exec_[A-Za-z0-9_-]+|pending_op_[A-Za-z0-9_-]+/u],
  ["grant_runtime_id", /grant_[a-z0-9]{6,}_[a-f0-9]{8,}/u]
]);

const GOVERNED_ENTITIES = Object.freeze([
  Object.freeze({ entityType: "authorization.role", entityId: "role-admin-review", capability: "role" }),
  Object.freeze({ entityType: "operation.registry", entityId: "external-service-forward", capability: "external-service" }),
  Object.freeze({ entityType: "document.asset", entityId: "document-controlled", capability: "document-access" }),
  Object.freeze({ entityType: "workspace.file", entityId: "workspace-file", capability: "workspace" }),
  Object.freeze({ entityType: "external_services.service", entityId: "upstream-service", capability: "upstream-service" }),
  Object.freeze({ entityType: "storage.object", entityId: "governed-object", capability: "storage" }),
  Object.freeze({ entityType: "organization.org", entityId: "org-private", capability: "organization" }),
  Object.freeze({ entityType: "console.resource", entityId: "admin-console", capability: "console" })
]);

function assertNoReportLeak(report) {
  const text = JSON.stringify(report);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Universal tag policy report contains sensitive local or runtime data: ${kind}.`);
    }
  }
}

function upsertTag(store, tagId, input = {}) {
  return store.upsertTag({
    tagId,
    kind: "custom",
    label: tagId,
    ...input
  });
}

function evaluate(store, entityRef, extra = {}) {
  return evaluateUniversalTagPolicy({
    tagStore: store,
    entityRefs: [entityRef],
    ...extra
  });
}

async function main() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-universal-tag-policy-"));
  const store = createTagStoreAdapter({ userDataPath });
  try {
    upsertTag(store, "governance:allow");
    upsertTag(store, "governance:allow:mid", { parentTagId: "governance:allow" });
    upsertTag(store, "governance:allow:mid:leaf", { parentTagId: "governance:allow:mid" });
    upsertTag(store, "governance:allow:sibling", { parentTagId: "governance:allow" });
    upsertTag(store, "governance:deny");
    upsertTag(store, "governance:deny:mid", { parentTagId: "governance:deny" });
    upsertTag(store, "governance:deny:mid:leaf", { parentTagId: "governance:deny:mid" });
    upsertTag(store, "governance:required");
    upsertTag(store, "governance:required:mid", { parentTagId: "governance:required" });
    upsertTag(store, "governance:required:mid:leaf", { parentTagId: "governance:required:mid" });

    for (const entity of GOVERNED_ENTITIES) {
      store.upsertProjection({
        tagId: "governance:allow:mid:leaf",
        entityType: entity.entityType,
        entityId: entity.entityId,
        payload: { capability: entity.capability }
      });
    }

    const rebuild = store.rebuildProjections();
    assert.equal(rebuild.count >= GOVERNED_ENTITIES.length, true, "projection rebuild must keep governed entity projections");

    const allowProofs = GOVERNED_ENTITIES.map((entity) => {
      const decision = evaluate(store, entity, { allowTags: ["governance:allow"] });
      assert.equal(decision.allowed, true, `${entity.capability} should be allowed through inherited allow tag`);
      assert.deepEqual(decision.matchedAllowTags, ["governance:allow"]);
      return {
        capability: entity.capability,
        reasonCode: decision.reasonCode,
        inheritedAllow: decision.matchedAllowTags.includes("governance:allow")
      };
    });

    const siblingIsolation = evaluate(store, GOVERNED_ENTITIES[0], { allowTags: ["governance:allow:sibling"] });
    assert.equal(siblingIsolation.allowed, false, "sibling tag must not match a different child branch");
    assert.equal(siblingIsolation.reasonCode, "tag_policy_allow_tag_missing");

    store.upsertProjection({
      tagId: "governance:required:mid:leaf",
      entityType: GOVERNED_ENTITIES[0].entityType,
      entityId: GOVERNED_ENTITIES[0].entityId,
      payload: { capability: GOVERNED_ENTITIES[0].capability, requiredVerifier: true }
    });
    const inheritedRequired = evaluate(store, GOVERNED_ENTITIES[0], {
      requiredTags: ["governance:required"]
    });
    assert.equal(inheritedRequired.allowed, true, "required parent tag must match a projected grandchild tag");

    for (const entity of GOVERNED_ENTITIES) {
      store.upsertProjection({
        tagId: "governance:deny:mid:leaf",
        entityType: entity.entityType,
        entityId: entity.entityId,
        payload: { capability: entity.capability, destructiveVerifier: true }
      });
    }

    const denyProofs = GOVERNED_ENTITIES.map((entity) => {
      const decision = evaluate(store, entity, {
        allowTags: ["governance:allow"],
        denyTags: ["governance:deny"]
      });
      assert.equal(decision.allowed, false, `${entity.capability} should be denied by deny tag`);
      assert.equal(decision.reasonCode, "tag_policy_denied");
      return {
        capability: entity.capability,
        reasonCode: decision.reasonCode,
        denyPrecedence: decision.matchedDenyTags.includes("governance:deny")
      };
    });

    const missingRequired = evaluate(store, {
      entityType: "document.asset",
      entityId: "document-missing-required",
      capability: "document-access"
    }, {
      requiredTags: ["governance:required"]
    });
    assert.equal(missingRequired.allowed, false);
    assert.equal(missingRequired.reasonCode, "tag_policy_required_tag_missing");

    const revisionBeforePolicyChange = store.getPolicyRevision().revision;
    upsertTag(store, "governance:revision-bump");
    const staleDecision = evaluate(store, GOVERNED_ENTITIES[0], {
      allowTags: ["governance:allow"],
      policyRevision: revisionBeforePolicyChange,
      failOnStale: true
    });
    assert.equal(staleDecision.allowed, false);
    assert.equal(staleDecision.reasonCode, "tag_policy_stale");

    store.archiveTag("governance:deny", { reason: "universal-tag-policy-verifier" });
    const revokeProofs = GOVERNED_ENTITIES.map((entity) => {
      const decision = evaluate(store, entity, {
        allowTags: ["governance:allow"],
        denyTags: ["governance:deny"]
      });
      assert.equal(decision.allowed, true, `${entity.capability} should allow after deny tag archive`);
      return {
        capability: entity.capability,
        denyTagRevoked: decision.matchedDenyTags.length === 0
      };
    });

    const provider = createSecurityPermissionsProvider({
      tagManagementStore: store,
      authorizationEngine: {
        evaluate: () => ({
          effect: "allow",
          allowed: true,
          reasonCode: "allowed",
          evaluatedLayers: ["authorization_subject"]
        })
      }
    });
    store.restoreTag("governance:deny");
    const providerDecision = provider.evaluatePolicy({
      operation: { id: "console.release.readiness" },
      context: {
        tagPolicy: {
          entityRefs: [{ entityType: "console.resource", entityId: "admin-console" }],
          allowTags: ["governance:allow"],
          denyTags: ["governance:deny"]
        }
      }
    });
    assert.equal(providerDecision.allowed, false);
    assert.equal(providerDecision.deniedLayer, "tag_policy");
    assert.equal(providerDecision.evaluatedLayers.includes("tag_policy"), true);

    const events = store.listEvents({ limit: 100 });
    assert.equal(events.some((event) => ["create", "update"].includes(event.eventType)), true, "tag upserts must be audited");
    assert.equal(events.some((event) => event.eventType === "archive"), true, "tag archives must be audited");
    assert.equal(events.some((event) => event.eventType === "restore"), true, "tag restores must be audited");
    assert.equal(events.some((event) => event.eventType === "rebuild"), true, "projection rebuild must be audited");

    const report = {
      schemaVersion: "v0.0.1:operation-permission:universal-tag-policy-report-1",
      generatedAt: new Date().toISOString(),
      verifier: "tools/server-scripts/verify-operation-permission-universal-tag-policy.mjs",
      auditReady: true,
      releaseReady: true,
      governedEntityTypes: GOVERNED_ENTITIES.map((entity) => ({
        entityType: entity.entityType,
        capability: entity.capability
      })),
      destructiveChecks: {
        inheritedAllowAdmission: allowProofs.every((proof) => proof.inheritedAllow),
        denyTagPrecedence: denyProofs.every((proof) => proof.denyPrecedence),
        siblingIsolation: siblingIsolation.reasonCode === "tag_policy_allow_tag_missing",
        inheritedRequiredAdmission: inheritedRequired.allowed === true,
        requiredTagMissingDenial: missingRequired.reasonCode === "tag_policy_required_tag_missing",
        staleRevisionDenial: staleDecision.reasonCode === "tag_policy_stale",
        denyTagRevocation: revokeProofs.every((proof) => proof.denyTagRevoked),
        securityPermissionsProviderEnforcesTagPolicy: providerDecision.deniedLayer === "tag_policy",
        projectionRebuildAudited: events.some((event) => event.eventType === "rebuild"),
        reportLeakScan: true
      },
      proofs: {
        allowProofs,
        denyProofs,
        revokeProofs,
        siblingIsolation: {
          reasonCode: siblingIsolation.reasonCode,
          matchedAllowTags: siblingIsolation.matchedAllowTags
        },
        inheritedRequired: {
          reasonCode: inheritedRequired.reasonCode,
          missingRequiredTags: inheritedRequired.missingRequiredTags
        },
        missingRequired: {
          reasonCode: missingRequired.reasonCode,
          missingRequiredTags: missingRequired.missingRequiredTags
        },
        staleRevision: {
          reasonCode: staleDecision.reasonCode,
          stale: staleDecision.stale
        },
        providerDecision: {
          reasonCode: providerDecision.reasonCode,
          deniedLayer: providerDecision.deniedLayer,
          evaluatedLayers: providerDecision.evaluatedLayers
        },
        auditEventTypes: [...new Set(events.map((event) => event.eventType))].sort()
      }
    };
    assertNoReportLeak(report);
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[operation-permission-universal-tag-policy] report=${REPORT_PATH}`);
    console.log(`[operation-permission-universal-tag-policy] entities=${GOVERNED_ENTITIES.length} releaseReady=true`);
  } finally {
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
