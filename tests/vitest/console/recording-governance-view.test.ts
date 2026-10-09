// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setConsoleLocaleState } from "../../../apps/console/i18n/console-locale-state.ts";

import RecordingGovernanceView from "../../../apps/console/views/admin/RecordingGovernanceView.vue";
import { useRecordingGovernanceController } from "../../../apps/console/composables/console-recording-governance-controller.ts";
import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

vi.mock("@meshrix/ui-console/bridge-http", () : any => ({ getJson: vi.fn(), postJson: vi.fn() }));

function selection(overrides: Record<string, any> = {}): any {
  return {
    obligation: "optional",
    sinkRef: "recording-sink-local",
    fieldAllow: ["ops.completed"],
    fieldRedact: [],
    eventAllow: [],
    readerRoles: ["role.rec.auditor"],
    configurerRoles: ["owner"],
    retention: { maxAgeSeconds: 3600, maxRecords: 32, maxContentBytes: 0, maxIndexBytes: 32768 },
    capacity: { maxBufferedRecords: 8, maxRecordBytes: 4096 },
    ...overrides
  };
}

function snapshot(overrides: Record<string, any> = {}): any {
  return {
    snapshot: {
      tenantId: "default",
      sink: {
        sinkId: "recording-sink-local",
        custody: "enterprise_local",
        durable: true,
        budgets: {
          maxRecordBytes: 262144,
          maxContentBytes: 1073741824,
          maxIndexBytes: 268435456,
          maxBufferedRecords: 65536,
          maxPendingWrites: 4096
        }
      },
      authority: {
        custody: "enterprise_local",
        durable: true,
        decryptionAuthority: "organization",
        decryptionAuthorityNote: "organization-controlled"
      },
      policy: {
        schemaVersion: "v0.0.1:recording:policy-1",
        kind: "recording-policy",
        policyId: "recording-policy",
        policyRevision: 1,
        issuedAt: "2026-10-10T00:00:00Z",
        issuerRole: "system",
        configurerRoles: ["owner", "maintainer"],
        categories: {}
      },
      sinkState: {
        sinkRef: "recording-sink-local",
        available: true,
        bufferedRecords: 0,
        pendingWrites: 0,
        contentBytesRemaining: 1073741824,
        indexBytesRemaining: 268435456
      },
      pendingObligations: [],
      ...overrides
    }
  };
}

function client(overrides: Record<string, any> = {}): any {
  return {
    getRecordingGovernanceSnapshot: vi.fn(async () : Promise<any> => snapshot()),
    getRecordingSinkHealth: vi.fn(async () : Promise<any> => ({
      health: {
        tenantId: "default",
        sink: snapshot().snapshot.sink,
        authority: snapshot().snapshot.authority,
        state: snapshot().snapshot.sinkState,
        policyRevision: 1
      }
    })),
    publishRecordingPolicy: vi.fn(async () : Promise<any> => ({
      published: {
        tenantId: "default",
        policy: { ...snapshot().snapshot.policy, policyRevision: 2 },
        sinkState: snapshot().snapshot.sinkState,
        pendingObligations: []
      }
    })),
    ...overrides
  };
}

beforeAll(() : any => {
  document.documentElement.lang = "en";
  setConsoleLocaleState("en");
});

describe("recording governance console", () : any => {
  it("separates enabled selection from obligation and shows org decryption authority", async () : Promise<any> => {
    const controller = useRecordingGovernanceController({ client: client() });
    await controller.refresh();
    expect(controller.policy.value?.policyRevision).toBe(1);
    expect(controller.authority.value?.decryptionAuthority).toBe("organization");
    expect(controller.authority.value?.custody).toBe("enterprise_local");
    // No all-on default: every category starts disabled.
    for (const key of controller.categories) {
      expect(controller.drafts.value[key].enabled).toBe(false);
    }
    controller.beginEditing();
    controller.setCategoryEnabled("usage", true);
    expect(controller.drafts.value.usage.enabled).toBe(true);
    // Enabled selection does not imply a required obligation.
    expect(controller.drafts.value.usage.obligation).toBe("optional");
    controller.drafts.value.usage.fieldAllowText = "ops.completed";
    controller.drafts.value.usage.readerRolesText = "role.rec.auditor";
    controller.drafts.value.usage.configurerRolesText = "owner";
    const built = controller.buildPolicy();
    expect(built.error).toBeUndefined();
    expect(built.policy?.policyRevision).toBe(2);
    expect(built.policy?.categories.usage.obligation).toBe("optional");
  });

  it("rejects a required obligation on a category that cannot carry one", async () : Promise<any> => {
    const controller = useRecordingGovernanceController({ client: client() });
    await controller.refresh();
    controller.beginEditing();
    controller.setCategoryEnabled("usage", true);
    controller.drafts.value.usage.obligation = "required_before_effect";
    controller.drafts.value.usage.fieldAllowText = "ops.completed";
    controller.drafts.value.usage.readerRolesText = "role.rec.auditor";
    controller.drafts.value.usage.configurerRolesText = "owner";
    const built = controller.buildPolicy();
    expect(built.error?.code).toBe("recording_policy_invalid");
  });

  it("publishes with CAS inputs and clears editing state", async () : Promise<any> => {
    const fake = client();
    const controller = useRecordingGovernanceController({ client: fake });
    await controller.refresh();
    controller.beginEditing();
    controller.setCategoryEnabled("usage", true);
    controller.drafts.value.usage.readerRolesText = "role.rec.auditor";
    controller.drafts.value.usage.configurerRolesText = "owner";
    controller.drafts.value.usage.fieldAllowText = "ops.completed";
    const published = await controller.publish();
    expect(published).toBe(true);
    expect(fake.publishRecordingPolicy).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1
    }));
    const sentPolicy = fake.publishRecordingPolicy.mock.calls[0][0].policy;
    expect(sentPolicy.policyRevision).toBe(2);
    expect(controller.policy.value?.policyRevision).toBe(2);
    expect(controller.editing.value).toBe(false);
  });

  it("surfaces a revision conflict truthfully and reloads", async () : Promise<any> => {
    const fake = client({
      publishRecordingPolicy: vi.fn(async () : Promise<any> => {
        throw new Error("Request failed: 409");
      })
    });
    const controller = useRecordingGovernanceController({ client: fake });
    await controller.refresh();
    controller.beginEditing();
    controller.setCategoryEnabled("usage", true);
    controller.drafts.value.usage.fieldAllowText = "ops.completed";
    controller.drafts.value.usage.readerRolesText = "role.rec.auditor";
    controller.drafts.value.usage.configurerRolesText = "owner";
    const published = await controller.publish();
    expect(published).toBe(false);
    expect(controller.revisionConflict.value).toBe(true);
    expect(controller.error.value?.code).toBe("recording_policy_revision_conflict");
    expect(fake.getRecordingGovernanceSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a degraded recorder distinct from operational state", async () : Promise<any> => {
    const degraded = snapshot({
      sinkState: {
        sinkRef: "recording-sink-local",
        available: false,
        bufferedRecords: 0,
        pendingWrites: 0,
        contentBytesRemaining: 0,
        indexBytesRemaining: 0
      }
    });
    const controller = useRecordingGovernanceController({
      client: client({ getRecordingGovernanceSnapshot: vi.fn(async () : Promise<any> => degraded) })
    });
    await controller.refresh();
    expect(controller.sinkAvailable.value).toBe(false);
    // The recorder being degraded never relabels required operational state.
    expect(controller.policy.value?.policyRevision).toBe(1);
  });

  it("classifies category-disabled pending obligations as limitations", async () : Promise<any> => {
    const pending = snapshot({
      pendingObligations: [
        {
          operationRef: "op.req.1",
          category: "execution_history",
          obligation: "required_before_effect",
          policyRevision: 2,
          reason: "category_disabled",
          createdAt: "2026-10-10T01:00:00Z"
        },
        {
          operationRef: "op.req.2",
          category: "usage",
          obligation: "optional",
          policyRevision: 2,
          reason: "capacity_exceeded",
          createdAt: "2026-10-10T01:05:00Z"
        }
      ]
    });
    const controller = useRecordingGovernanceController({
      client: client({ getRecordingGovernanceSnapshot: vi.fn(async () : Promise<any> => pending) })
    });
    await controller.refresh();
    expect(controller.pendingObligations.value).toHaveLength(2);
    expect(controller.incompleteObligations.value).toHaveLength(1);
    expect(controller.incompleteObligations.value[0].reason).toBe("category_disabled");
  });

  it("renders custody, decryption authority, health and limitation copy", async () : Promise<any> => {
    const pending = snapshot({
      pendingObligations: [
        {
          operationRef: "op.req.1",
          category: "execution_history",
          obligation: "required_before_effect",
          policyRevision: 2,
          reason: "category_disabled",
          createdAt: "2026-10-10T01:00:00Z"
        }
      ]
    });
    vi.mocked(getJson).mockImplementation(async (url: string) : Promise<any> => {
      if (String(url).includes("/sink/health")) {
        return { health: {
          tenantId: "default",
          sink: pending.snapshot.sink,
          authority: pending.snapshot.authority,
          state: pending.snapshot.sinkState,
          policyRevision: 1
        } };
      }
      return pending;
    });
    const wrapper = mount(RecordingGovernanceView);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("Recording Governance");
    expect(text).toContain("enterprise_local");
    expect(text).toContain("organization");
    expect(text).toContain("Pending Recording Obligations");
    expect(text).toContain("Category disabled");
    wrapper.unmount();
  });
});
