import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateUniversalTagPolicy
} from "../../../packages/foundation/src/security/authorization/universal-tag-policy.mjs";
import {
  createSecurityPermissionsProvider
} from "../../../packages/foundation/src/security/security-permissions-provider.mjs";
import { createTagStoreAdapter } from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.mjs";

async function withTagStore(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-universal-tag-policy-"));
  const store = createTagStoreAdapter({ userDataPath });
  try {
    return await testCase(store);
  } finally {
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
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

describe("universal tag policy evaluator", () => {
  it("applies inherited allow tags, deny precedence, missing required denial, revocation, and stale revision", async () => {
    await withTagStore(async (store) => {
      upsertTag(store, "governed:allow");
      upsertTag(store, "governed:package", { parentTagId: "governed:allow" });
      upsertTag(store, "governed:deny");
      upsertTag(store, "governed:required");

      store.upsertProjection({
        tagId: "governed:package",
        entityType: "sample_plugin.package",
        entityId: "package-alpha",
        payload: { id: "package-alpha" }
      });
      store.upsertProjection({
        tagId: "governed:deny",
        entityType: "external_services.service",
        entityId: "service-blocked",
        payload: { id: "service-blocked" }
      });

      expect(evaluateUniversalTagPolicy({
        tagStore: store,
        entityRefs: [{ entityType: "sample_plugin.package", entityId: "package-alpha" }],
        allowTags: ["governed:allow"]
      })).toMatchObject({
        allowed: true,
        reasonCode: "tag_policy_allowed",
        matchedAllowTags: ["governed:allow"]
      });

      expect(evaluateUniversalTagPolicy({
        tagStore: store,
        entityRefs: [{ entityType: "external_services.service", entityId: "service-blocked" }],
        allowTags: ["governed:allow"],
        denyTags: ["governed:deny"]
      })).toMatchObject({
        allowed: false,
        reasonCode: "tag_policy_denied",
        deniedLayer: "tag_policy",
        matchedDenyTags: ["governed:deny"]
      });

      expect(evaluateUniversalTagPolicy({
        tagStore: store,
        entityRefs: [{ entityType: "document.asset", entityId: "doc-missing" }],
        requiredTags: ["governed:required"]
      })).toMatchObject({
        allowed: false,
        reasonCode: "tag_policy_required_tag_missing",
        missingRequiredTags: ["governed:required"]
      });

      const beforeArchiveRevision = store.getPolicyRevision().revision;
      store.archiveTag("governed:deny", { reason: "unit-test" });
      expect(evaluateUniversalTagPolicy({
        tagStore: store,
        entityRefs: [{ entityType: "external_services.service", entityId: "service-blocked" }],
        denyTags: ["governed:deny"]
      })).toMatchObject({
        allowed: true,
        reasonCode: "tag_policy_allowed",
        matchedDenyTags: []
      });

      expect(evaluateUniversalTagPolicy({
        tagStore: store,
        entityRefs: [{ entityType: "sample_plugin.package", entityId: "package-alpha" }],
        allowTags: ["governed:allow"],
        policyRevision: beforeArchiveRevision,
        failOnStale: true
      })).toMatchObject({
        allowed: false,
        reasonCode: "tag_policy_stale",
        stale: true
      });
    });
  });

  it("is used by the security permissions provider when a tag policy is supplied", async () => {
    await withTagStore(async (store) => {
      upsertTag(store, "governed:allow");
      upsertTag(store, "governed:deny");
      store.upsertProjection({
        tagId: "governed:deny",
        entityType: "console.resource",
        entityId: "release-panel",
        payload: { id: "release-panel" }
      });

      const provider = createSecurityPermissionsProvider({
        tagManagementStore: store,
        authorizationEngine: {
          evaluate: () => ({
            allowed: true,
            effect: "allow",
            reasonCode: "allowed",
            evaluatedLayers: ["authorization_subject"]
          })
        }
      });

      const decision = provider.evaluatePolicy({
        operation: { id: "console.release.open" },
        context: {
          tagPolicy: {
            entityRefs: [{ entityType: "console.resource", entityId: "release-panel" }],
            denyTags: ["governed:deny"],
            allowTags: ["governed:allow"]
          }
        }
      });

      expect(decision).toMatchObject({
        allowed: false,
        effect: "deny",
        reasonCode: "tag_policy_denied",
        deniedLayer: "tag_policy",
        evaluatedLayers: ["authorization_subject", "tag_policy"]
      });
      expect(decision.effectivePolicySnapshot.tagPolicy).toMatchObject({
        allowed: false,
        matchedDenyTags: ["governed:deny"]
      });
    });
  });

  it("is used by the security permissions provider for nested Operation Permission tool input", async () => {
    await withTagStore(async (store) => {
      upsertTag(store, "governed:deny");
      store.upsertProjection({
        tagId: "governed:deny",
        entityType: "external_services.service",
        entityId: "service-blocked",
        payload: { id: "service-blocked" }
      });

      const provider = createSecurityPermissionsProvider({
        tagManagementStore: store,
        authorizationEngine: {
          evaluate: () => ({
            allowed: true,
            effect: "allow",
            reasonCode: "allowed",
            evaluatedLayers: ["authorization_subject"]
          })
        }
      });

      const decision = provider.evaluatePolicy({
        operation: { id: "external_services.forward" },
        input: {
          serviceId: "service-blocked",
          tagPolicy: {
            entityRefs: [{ entityType: "external_services.service", entityId: "service-blocked" }],
            denyTags: ["governed:deny"]
          }
        },
        context: {
          toolExpected: true
        }
      });

      expect(decision).toMatchObject({
        allowed: false,
        effect: "deny",
        reasonCode: "tag_policy_denied",
        deniedLayer: "tag_policy",
        evaluatedLayers: ["authorization_subject", "tag_policy"]
      });
      expect(decision.effectivePolicySnapshot.tagPolicy).toMatchObject({
        allowed: false,
        matchedDenyTags: ["governed:deny"]
      });
    });
  });
});
