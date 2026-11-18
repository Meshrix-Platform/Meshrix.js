import { computed, onMounted, ref } from "vue";
import {
  getRecordingGovernanceSnapshot,
  getRecordingSinkHealth,
  publishRecordingPolicy,
  type RecordingCategorySelection,
  type RecordingGovernanceSnapshot,
  type RecordingPendingObligation,
  type RecordingPolicy,
  type RecordingSinkHealth,
} from "../lib/recording-governance-client";
import {
  RECORDING_GOVERNANCE_CATEGORIES,
  recordingGovernanceText,
} from "../i18n/recording-governance";

type RecordingGovernanceClient = {
  getRecordingGovernanceSnapshot: typeof getRecordingGovernanceSnapshot;
  getRecordingSinkHealth: typeof getRecordingSinkHealth;
  publishRecordingPolicy: typeof publishRecordingPolicy;
};

export type RecordingCategoryDraft = {
  key: string;
  enabled: boolean;
  obligation: string;
  sinkRef: string;
  fieldAllowText: string;
  fieldRedactText: string;
  eventAllowText: string;
  readerRolesText: string;
  configurerRolesText: string;
  retentionMaxAgeSeconds: string;
  retentionMaxRecords: string;
  retentionMaxContentBytes: string;
  retentionMaxIndexBytes: string;
  capacityMaxBufferedRecords: string;
  capacityMaxRecordBytes: string;
};

export type RecordingGovernanceError = {
  code: string;
  message: string;
  currentRevision?: number;
};

const REQUIRED_OBLIGATION_CATEGORIES: ReadonlySet<string> = new Set([
  "execution_history",
  "governance_history",
]);

function parseListText(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listText(value: readonly string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function draftFromSelection(key: string, selection?: RecordingCategorySelection, sinkRef = ""): RecordingCategoryDraft {
  return {
    key,
    enabled: Boolean(selection),
    obligation: selection?.obligation || "optional",
    sinkRef: selection?.sinkRef || sinkRef,
    fieldAllowText: listText(selection?.fieldAllow),
    fieldRedactText: listText(selection?.fieldRedact),
    eventAllowText: listText(selection?.eventAllow),
    readerRolesText: listText(selection?.readerRoles),
    configurerRolesText: listText(selection?.configurerRoles),
    retentionMaxAgeSeconds: String(selection?.retention?.maxAgeSeconds ?? 86400),
    retentionMaxRecords: String(selection?.retention?.maxRecords ?? 10000),
    retentionMaxContentBytes: String(selection?.retention?.maxContentBytes ?? 0),
    retentionMaxIndexBytes: String(selection?.retention?.maxIndexBytes ?? 16_777_216),
    capacityMaxBufferedRecords: String(selection?.capacity?.maxBufferedRecords ?? 1024),
    capacityMaxRecordBytes: String(selection?.capacity?.maxRecordBytes ?? 65_536),
  };
}

function boundedIntFrom(text: string, { min, max, fallback }: { min: number; max: number; fallback: number }): number | null {
  const value = Number(String(text || "").trim());
  if (!Number.isSafeInteger(value)) return fallback >= min && fallback <= max ? fallback : null;
  if (value < min || value > max) return null;
  return value;
}

export function useRecordingGovernanceController(options: { client?: RecordingGovernanceClient } = {}) {
  const client: RecordingGovernanceClient = options.client || {
    getRecordingGovernanceSnapshot,
    getRecordingSinkHealth,
    publishRecordingPolicy,
  };

  const loading = ref(false);
  const refreshingHealth = ref(false);
  const publishing = ref(false);
  const error = ref<RecordingGovernanceError | null>(null);
  const statusMessage = ref("");
  const snapshot = ref<RecordingGovernanceSnapshot | null>(null);
  const health = ref<RecordingSinkHealth | null>(null);
  const drafts = ref<Record<string, RecordingCategoryDraft>>({});
  const configurerRolesText = ref("");
  const policyIssuerRole = ref("console");
  const dirty = ref(false);
  const revisionConflict = ref(false);
  const editing = ref(false);

  const categories = RECORDING_GOVERNANCE_CATEGORIES;

  const policy = computed(() => snapshot.value?.policy || null);
  const sink = computed(() => health.value?.sink || snapshot.value?.sink || null);
  const sinkState = computed(() => health.value?.state || snapshot.value?.sinkState || null);
  const authority = computed(() => health.value?.authority || snapshot.value?.authority || null);
  const pendingObligations = computed<RecordingPendingObligation[]>(() =>
    snapshot.value?.pendingObligations || []
  );
  const expectedRevision = computed(() => Number(policy.value?.policyRevision || 0));
  const sinkAvailable = computed(() => sinkState.value?.available === true);
  const integrity = computed(() => health.value?.integrity || null);

  /**
   * Truthful limitation list: obligations that are still owed after their
   * category was disabled are incomplete admitted audits — never completed
   * history. The view renders these as limitations, not as fulfilled records.
   */
  const incompleteObligations = computed<RecordingPendingObligation[]>(() =>
    pendingObligations.value.filter((entry) => entry.reason === "category_disabled")
  );

  function errorFrom(exception: unknown, fallbackCode = "recording_governance_failed"): RecordingGovernanceError {
    const message = exception instanceof Error ? exception.message : String(exception || "");
    const conflict = /\b409\b/.test(message);
    return {
      code: conflict ? "recording_policy_revision_conflict" : fallbackCode,
      message: conflict
        ? recordingGovernanceText(
            "录制策略已被其他修订发布，请重新加载后再发布。",
            "The recording policy was published by another revision; reload before publishing.")
        : message || fallbackCode,
    };
  }

  function hydrateDrafts(value: RecordingGovernanceSnapshot | null) {
    const sinkRef = String(value?.sink?.sinkId || "");
    const next: Record<string, RecordingCategoryDraft> = {};
    for (const key of categories) {
      next[key] = draftFromSelection(key, value?.policy?.categories?.[key], sinkRef);
    }
    drafts.value = next;
    configurerRolesText.value = listText(value?.policy?.configurerRoles);
    dirty.value = false;
    revisionConflict.value = false;
  }

  async function refresh() {
    loading.value = true;
    error.value = null;
    try {
      const response = await client.getRecordingGovernanceSnapshot();
      snapshot.value = response.snapshot;
      if (!editing.value) {
        hydrateDrafts(snapshot.value);
      }
      statusMessage.value = recordingGovernanceText("录制策略已加载。", "Recording policy loaded.");
    } catch (exception) {
      error.value = errorFrom(exception, "recording_governance_unavailable");
      statusMessage.value = "";
    } finally {
      loading.value = false;
    }
  }

  async function refreshHealth(integrityCheck = true) {
    refreshingHealth.value = true;
    error.value = null;
    try {
      const response = await client.getRecordingSinkHealth(integrityCheck);
      health.value = response.health;
    } catch (exception) {
      error.value = errorFrom(exception, "recording_governance_unavailable");
    } finally {
      refreshingHealth.value = false;
    }
  }

  function beginEditing() {
    editing.value = true;
    hydrateDrafts(snapshot.value);
  }

  function setCategoryEnabled(key: string, enabled: boolean) {
    const draft = drafts.value[key];
    if (!draft) return;
    draft.enabled = enabled === true;
    dirty.value = true;
  }

  function markDirty() {
    dirty.value = true;
  }

  function buildPolicy(): { policy?: RecordingPolicy; error?: RecordingGovernanceError } {
    const current = policy.value;
    if (!current) {
      return { error: { code: "recording_policy_required", message: "Recording policy is not loaded." } };
    }
    const configurerRoles = parseListText(configurerRolesText.value);
    if (configurerRoles.length === 0) {
      return {
        error: {
          code: "recording_policy_invalid",
          message: recordingGovernanceText(
            "至少需要一个策略配置角色。",
            "At least one policy configurer role is required."),
        },
      };
    }
    const nextCategories: Record<string, RecordingCategorySelection> = {};
    for (const key of categories) {
      const draft = drafts.value[key];
      if (!draft || !draft.enabled) continue;
      if (draft.obligation === "required_before_effect" && !REQUIRED_OBLIGATION_CATEGORIES.has(key)) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              `类别 ${key} 不能声明 required_before_effect。`,
              `Category ${key} cannot declare required_before_effect.`),
          },
        };
      }
      const maxAgeSeconds = boundedIntFrom(draft.retentionMaxAgeSeconds, { min: 1, max: 31_536_000, fallback: NaN });
      const maxRecords = boundedIntFrom(draft.retentionMaxRecords, { min: 1, max: 1_000_000, fallback: NaN });
      const maxContentBytes = boundedIntFrom(draft.retentionMaxContentBytes, { min: 0, max: 1_073_741_824, fallback: NaN });
      const maxIndexBytes = boundedIntFrom(draft.retentionMaxIndexBytes, { min: 1, max: 1_073_741_824, fallback: NaN });
      const maxBufferedRecords = boundedIntFrom(draft.capacityMaxBufferedRecords, { min: 1, max: 65_536, fallback: NaN });
      const maxRecordBytes = boundedIntFrom(draft.capacityMaxRecordBytes, { min: 1, max: 262_144, fallback: NaN });
      if ([maxAgeSeconds, maxRecords, maxContentBytes, maxIndexBytes, maxBufferedRecords, maxRecordBytes].some((v) => v === null || Number.isNaN(v as number))) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              `类别 ${key} 的保留或容量预算超出边界。`,
              `Retention or capacity budgets for ${key} are out of bounds.`),
          },
        };
      }
      if (key !== "content" && (maxContentBytes as number) !== 0) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              "只有 content 类别可以持有内容字节预算。",
              "Only the content category may hold a content-byte budget."),
          },
        };
      }
      const readerRoles = parseListText(draft.readerRolesText);
      const categoryConfigurerRoles = parseListText(draft.configurerRolesText);
      if (readerRoles.length === 0 || categoryConfigurerRoles.length === 0) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              `类别 ${key} 需要读取角色与配置角色。`,
              `Category ${key} requires reader and configurer roles.`),
          },
        };
      }
      const fieldAllow = parseListText(draft.fieldAllowText);
      const eventAllow = parseListText(draft.eventAllowText);
      if ((key === "content" || key === "usage") && fieldAllow.length === 0) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              `类别 ${key} 需要至少一个字段白名单项。`,
              `Category ${key} requires at least one field allowlist entry.`),
          },
        };
      }
      if (key === "diagnostics" && eventAllow.length === 0) {
        return {
          error: {
            code: "recording_policy_invalid",
            message: recordingGovernanceText(
              "diagnostics 类别需要至少一个事件白名单项。",
              "The diagnostics category requires at least one event allowlist entry."),
          },
        };
      }
      nextCategories[key] = {
        obligation: draft.obligation === "required_before_effect" ? "required_before_effect" : "optional",
        sinkRef: draft.sinkRef.trim(),
        fieldAllow,
        fieldRedact: parseListText(draft.fieldRedactText),
        eventAllow,
        readerRoles,
        configurerRoles: categoryConfigurerRoles,
        retention: {
          maxAgeSeconds: maxAgeSeconds as number,
          maxRecords: maxRecords as number,
          maxContentBytes: maxContentBytes as number,
          maxIndexBytes: maxIndexBytes as number,
        },
        capacity: {
          maxBufferedRecords: maxBufferedRecords as number,
          maxRecordBytes: maxRecordBytes as number,
        },
      };
    }
    const nextPolicy: RecordingPolicy = {
      schemaVersion: "v0.0.1:recording:policy-1",
      kind: "recording-policy",
      policyId: current.policyId,
      policyRevision: expectedRevision.value + 1,
      issuedAt: new Date().toISOString(),
      issuerRole: policyIssuerRole.value.trim() || "console",
      configurerRoles,
      categories: nextCategories,
    };
    return { policy: nextPolicy };
  }

  async function publish() {
    const built = buildPolicy();
    if (built.error || !built.policy) {
      error.value = built.error || { code: "recording_policy_invalid", message: "Invalid policy." };
      return false;
    }
    publishing.value = true;
    error.value = null;
    try {
      const response = await client.publishRecordingPolicy({
        expectedRevision: expectedRevision.value,
        policy: built.policy,
      });
      snapshot.value = {
        tenantId: response.published.tenantId,
        sink: snapshot.value?.sink as RecordingGovernanceSnapshot["sink"],
        authority: snapshot.value?.authority as RecordingGovernanceSnapshot["authority"],
        policy: response.published.policy,
        sinkState: response.published.sinkState,
        pendingObligations: response.published.pendingObligations,
      };
      editing.value = false;
      hydrateDrafts(snapshot.value);
      statusMessage.value = recordingGovernanceText("录制策略修订已发布。", "Recording policy revision published.");
      return true;
    } catch (exception) {
      const failure = errorFrom(exception, "recording_policy_publish_failed");
      error.value = failure;
      if (failure.code === "recording_policy_revision_conflict") {
        // Reload truthfully, then keep the conflict visible to the operator.
        await refresh();
        revisionConflict.value = true;
        error.value = failure;
      }
      statusMessage.value = "";
      return false;
    } finally {
      publishing.value = false;
    }
  }

  onMounted(() => {
    void refresh();
    void refreshHealth(false);
  });

  return {
    loading,
    refreshingHealth,
    publishing,
    error,
    statusMessage,
    snapshot,
    health,
    policy,
    sink,
    sinkState,
    authority,
    integrity,
    pendingObligations,
    incompleteObligations,
    expectedRevision,
    sinkAvailable,
    categories,
    drafts,
    configurerRolesText,
    dirty,
    editing,
    revisionConflict,
    refresh,
    refreshHealth,
    beginEditing,
    setCategoryEnabled,
    markDirty,
    buildPolicy,
    publish,
  };
}
