<script setup lang="ts">
import { computed, ref } from 'vue';
import { useServerConsoleShellContext } from '../../composables/serverConsoleShellContext';
import { jsonPreview } from '../../composables/console-format-utils';
import { confirmConsoleAction, notifyConsoleAction } from '../../composables/console-browser-effects';
import {
  buildContextProfileFromForm,
  createContextProfileCandidateTemplate,
  createContextProfileForm,
  validateContextProfileForm,
  type ContextProfileForm,
} from '../../composables/console-context-compiler-controller';
import ConfigFoldCard from '../../components/ConfigFoldCard.vue';
import { saveContextProfiles } from '../../lib/context-compiler-client';
import ContextBuildRecordCard from './context-management/ContextBuildRecordCard.vue';
import ContextPresetListCard from './context-management/ContextPresetListCard.vue';
import ContextPresetModal from './context-management/ContextPresetModal.vue';
import ContextPreviewPanel from './context-management/ContextPreviewPanel.vue';

const {
  busyKey,
  contextBuildRecordRows,
  contextEvaluationResult,
  contextPreviewRequiredEvidence,
  contextPreviewResult,
  contextPreviewTask,
  contextProfileRows,
  contextProfilesResponse,
  exportContextBuildRecords,
  highlightedConfigTarget,
  previewContextCompiler,
  refreshContextCompiler,
  runContextReplayEvaluation,
} = useServerConsoleShellContext();

type ContextProfileRow = (typeof contextProfileRows.value)[number];

const showPresetModal = ref(false);
const savingPreset = ref(false);
const editingProfileId = ref("");
const presetFormError = ref("");
const presetSourceProfile = ref<Record<string, unknown> | null>(null);
const presetForm = ref<ContextProfileForm>(createContextProfileForm());
const presetModalTitle = computed(() => editingProfileId.value ? "编辑上下文配置" : "新增上下文配置");

function profileRecords() {
  const profiles = contextProfilesResponse.value?.profiles;
  return Array.isArray(profiles)
    ? profiles
      .filter((profile): profile is Record<string, unknown> => !!profile && typeof profile === "object")
    : [];
}

function sortProfiles(profiles: Record<string, unknown>[]) {
  return [...profiles].sort((left, right) => {
    const tokenCompare = Number(left.contextWindowTokens || 0) - Number(right.contextWindowTokens || 0);
    if (tokenCompare !== 0) return tokenCompare;
    return String(left.profileId || "").localeCompare(String(right.profileId || ""));
  });
}

function rawProfileFor(profileId: string) {
  return profileRecords().find((profile) => String(profile.profileId ?? "") === profileId) || {};
}

function openAddPresetModal() {
  const candidate = createContextProfileCandidateTemplate();
  editingProfileId.value = "";
  presetFormError.value = "";
  presetSourceProfile.value = candidate;
  presetForm.value = createContextProfileForm(candidate);
  showPresetModal.value = true;
}

function openEditPresetModal(profile: ContextProfileRow) {
  const sourceProfile = rawProfileFor(profile.profileId);
  editingProfileId.value = profile.profileId;
  presetFormError.value = "";
  presetSourceProfile.value = sourceProfile;
  presetForm.value = createContextProfileForm(sourceProfile);
  showPresetModal.value = true;
}

function resetPresetForm() {
  editingProfileId.value = "";
  presetSourceProfile.value = null;
  presetForm.value = createContextProfileForm();
}

function closePresetModal() {
  if (savingPreset.value) return;
  showPresetModal.value = false;
  presetFormError.value = "";
  resetPresetForm();
}

async function persistProfiles(nextProfiles: Record<string, unknown>[]) {
  savingPreset.value = true;
  presetFormError.value = "";
  try {
    const response = await saveContextProfiles({ profiles: sortProfiles(nextProfiles) });
    contextProfilesResponse.value = response;
    await refreshContextCompiler({ silent: true });
    showPresetModal.value = false;
    resetPresetForm();
    return true;
  } catch (err) {
    presetFormError.value = err instanceof Error ? err.message : "保存上下文配置失败。";
    return false;
  } finally {
    savingPreset.value = false;
  }
}

async function savePresetForm() {
  const profileId = presetForm.value.profileId.trim();
  const validationError = validateContextProfileForm(presetForm.value);
  if (validationError) {
    presetFormError.value = validationError;
    return;
  }
  const conflict = profileRecords().some((profile) =>
    String(profile.profileId ?? "") === profileId &&
      String(profile.profileId ?? "") !== editingProfileId.value,
  );
  if (conflict) {
    presetFormError.value = "Profile ID 已存在。";
    return;
  }

  const nextProfile = buildContextProfileFromForm(
    presetForm.value,
    presetSourceProfile.value || {},
  );
  const nextProfiles = profileRecords().filter((profile) =>
    String(profile.profileId ?? "") !== editingProfileId.value,
  );
  nextProfiles.push(nextProfile);
  await persistProfiles(nextProfiles);
}

async function deletePreset(profile: ContextProfileRow) {
  const label = profile.label || profile.profileId;
  if (!(await confirmConsoleAction(`删除上下文预设“${label}”？`, { tone: "danger" }))) {
    return;
  }
  const saved = await persistProfiles(
    profileRecords().filter((item) => String(item.profileId ?? "") !== profile.profileId),
  );
  if (!saved) {
    notifyConsoleAction(presetFormError.value || "删除上下文预设失败。", { tone: "danger" });
  }
}

</script>

<template>
          <section class="agent-config-layout">
            <article class="surface-card">
              <div class="drawer-panel">
                <ContextPresetListCard
                  :profiles="contextProfileRows"
                  :saving="savingPreset"
                  @add="openAddPresetModal"
                  @edit="openEditPresetModal"
                  @delete="deletePreset"
                />

                <ContextPreviewPanel
                  v-model:task="contextPreviewTask"
                  v-model:required-evidence="contextPreviewRequiredEvidence"
                  :busy-key="busyKey"
                  :export-disabled="!contextBuildRecordRows.length"
                  @preview="previewContextCompiler"
                  @evaluate="runContextReplayEvaluation"
                  @export="exportContextBuildRecords"
                />

                <ConfigFoldCard v-if="contextPreviewResult" title="本轮上下文包" open>
                  <pre>{{ jsonPreview(contextPreviewResult) }}</pre>
                </ConfigFoldCard>
                <ConfigFoldCard v-if="contextEvaluationResult" title="Replay 评估结果" open>
                  <pre>{{ jsonPreview(contextEvaluationResult) }}</pre>
                </ConfigFoldCard>

                <ContextBuildRecordCard
                  :records="contextBuildRecordRows"
                  :highlighted="highlightedConfigTarget === 'approval-flow-agent'"
                />
              </div>

              <ContextPresetModal
                v-if="showPresetModal"
                :form="presetForm"
                :form-error="presetFormError"
                :saving="savingPreset"
                :title="presetModalTitle"
                @close="closePresetModal"
                @save="savePresetForm"
              />
            </article>
          </section>
</template>
