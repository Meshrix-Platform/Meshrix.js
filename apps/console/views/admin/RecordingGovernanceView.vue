<script setup lang="ts">
import { computed } from "vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import { useRecordingGovernanceController } from "../../composables/console-recording-governance-controller";
import {
  recordingCategoryName,
  recordingGovernanceText,
  recordingObligationName,
  recordingPendingReasonName,
} from "../../i18n/recording-governance";

const {
  authority,
  categories,
  configurerRolesText,
  dirty,
  editing,
  error,
  expectedRevision,
  incompleteObligations,
  integrity,
  loading,
  pendingObligations,
  publish,
  publishing,
  refresh,
  refreshHealth,
  refreshingHealth,
  revisionConflict,
  beginEditing,
  setCategoryEnabled,
  markDirty,
  sink,
  sinkState,
  statusMessage,
  drafts,
} = useRecordingGovernanceController();

const requiredObligationCategories = new Set(["execution_history", "governance_history"]);

const sinkHealthLabel = computed(() => {
  if (!sinkState.value) {
    return recordingGovernanceText("未知", "Unknown");
  }
  return sinkState.value.available
    ? recordingGovernanceText("可用", "Available")
    : recordingGovernanceText("不可用（降级）", "Unavailable (degraded)");
});
</script>

<template>
  <section class="recording-governance-layout">
    <section class="surface-card">
      <div class="section-header">
        <div>
          <h3>{{ recordingGovernanceText("录制治理", "Recording Governance") }}</h3>
          <p>
            {{ recordingGovernanceText(
              "管理企业本地录制策略：类别选择、字段白名单、保留与容量预算、访问角色与汇集健康。",
              "Administer the enterprise-local recording policy: category selection, field allowlists, retention and capacity budgets, access roles, and sink health.") }}
          </p>
        </div>
        <div class="section-tags">
          <span>{{ recordingGovernanceText("策略修订", "Revision") }} {{ expectedRevision }}</span>
          <span>{{ recordingGovernanceText("汇集", "Sink") }} {{ sinkHealthLabel }}</span>
        </div>
      </div>
      <div class="source-actions">
        <button class="table-action" type="button" :disabled="loading" @click="refresh">
          {{ recordingGovernanceText("刷新策略", "Refresh Policy") }}
        </button>
        <button class="table-action" type="button" :disabled="refreshingHealth" @click="refreshHealth(true)">
          {{ recordingGovernanceText("校验汇集完整性", "Verify Sink Integrity") }}
        </button>
        <button v-if="!editing" class="tool-button" type="button" @click="beginEditing">
          {{ recordingGovernanceText("编辑策略", "Edit Policy") }}
        </button>
        <button
          v-else
          class="tool-button"
          type="button"
          :disabled="!dirty || publishing"
          @click="publish"
        >
          {{ publishing
            ? recordingGovernanceText("发布中…", "Publishing…")
            : recordingGovernanceText("发布修订", "Publish Revision") }}
        </button>
      </div>
    </section>

    <ConsoleInlineAlert v-if="error" tone="danger">{{ error.message }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="revisionConflict" tone="danger">
      {{ recordingGovernanceText(
        "录制策略已被其他修订发布；表单已重新加载到当前修订，请重新应用变更。",
        "The recording policy was published by another revision; the form was reloaded at the current revision. Re-apply your changes.") }}
    </ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="statusMessage" tone="success">{{ statusMessage }}</ConsoleInlineAlert>

    <section class="surface-card">
      <div class="section-header">
        <h4>{{ recordingGovernanceText("汇集托管与访问边界", "Sink Custody and Access Boundary") }}</h4>
      </div>
      <dl class="recording-facts">
        <div>
          <dt>{{ recordingGovernanceText("托管", "Custody") }}</dt>
          <dd>{{ authority?.custody || sink?.custody || "enterprise_local" }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("持久化", "Durable") }}</dt>
          <dd>{{ (sink?.durable ?? true) ? recordingGovernanceText("是", "Yes") : recordingGovernanceText("否", "No") }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("读取权限", "Content Access") }}</dt>
          <dd>{{ authority?.contentAccess || "organization" }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("汇集标识", "Sink ID") }}</dt>
          <dd>{{ sink?.sinkId || "—" }}</dd>
        </div>
      </dl>
      <p class="recording-note">
        {{ authority?.contentAccessNote || recordingGovernanceText(
          "录制内容以未加密形式存放在本部署录制根目录下的私有本地文件中；运行本部署的组织及其文件系统管理员可读取录制内容，不存在独立的加密或密钥边界。",
          "Recorded content is stored unencrypted in private local files under this deployment's recording root. The operating organization and its filesystem administrators can read recorded content; no separate encryption or key boundary exists.") }}
      </p>
      <p class="recording-note">
        {{ recordingGovernanceText(
          "汇集健康只反映录制器状态；最小正确性状态（授权、回放围栏、执行意图、结果对账）由各自的权威组件单独维护。",
          "Sink health reflects recorder state only; minimal correctness state (grants, replay fences, execution intents, outcome reconciliation) is maintained separately at its own authorities.") }}
      </p>
    </section>

    <section class="surface-card">
      <div class="section-header">
        <h4>{{ recordingGovernanceText("汇集健康", "Sink Health") }}</h4>
      </div>
      <dl class="recording-facts">
        <div>
          <dt>{{ recordingGovernanceText("状态", "State") }}</dt>
          <dd>{{ sinkHealthLabel }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("缓冲记录", "Buffered Records") }}</dt>
          <dd>{{ sinkState?.bufferedRecords ?? "—" }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("待写", "Pending Writes") }}</dt>
          <dd>{{ sinkState?.pendingWrites ?? "—" }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("剩余内容字节", "Content Bytes Remaining") }}</dt>
          <dd>{{ sinkState?.contentBytesRemaining ?? "—" }}</dd>
        </div>
        <div>
          <dt>{{ recordingGovernanceText("剩余索引字节", "Index Bytes Remaining") }}</dt>
          <dd>{{ sinkState?.indexBytesRemaining ?? "—" }}</dd>
        </div>
        <div v-if="integrity">
          <dt>{{ recordingGovernanceText("完整性", "Integrity") }}</dt>
          <dd>
            {{ integrity.intact === true
              ? recordingGovernanceText("完好", "Intact")
              : recordingGovernanceText("存在分歧或未检查", "Diverged or unchecked") }}
            <template v-if="integrity.journalEntries !== undefined">
              — {{ recordingGovernanceText("日志条目", "journal") }} {{ integrity.journalEntries }}
            </template>
          </dd>
        </div>
      </dl>
    </section>

    <section v-if="editing" class="surface-card">
      <div class="section-header">
        <h4>{{ recordingGovernanceText("策略配置角色", "Policy Configurer Roles") }}</h4>
      </div>
      <label class="recording-field">
        <span>{{ recordingGovernanceText("配置角色（每行一个）", "Configurer roles (one per line)") }}</span>
        <textarea v-model="configurerRolesText" rows="2" @input="markDirty" />
      </label>
    </section>

    <section class="recording-categories">
      <article v-for="key in categories" :key="key" class="surface-card recording-category">
        <div class="section-header">
          <div>
            <h4>{{ recordingCategoryName(key) }}</h4>
            <p class="recording-note">
              {{ recordingGovernanceText(
                "启用仅表示选择记录该类别；义务（可选 / 生效前必需）独立声明。",
                "Enablement only selects the category for recording; its obligation (optional / required before effect) is declared separately.") }}
            </p>
          </div>
          <label class="recording-toggle">
            <input
              type="checkbox"
              :checked="drafts[key]?.enabled"
              :disabled="!editing"
              @change="setCategoryEnabled(key, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ drafts[key]?.enabled
              ? recordingGovernanceText("已启用", "Enabled")
              : recordingGovernanceText("已停用", "Disabled") }}</span>
          </label>
        </div>

        <template v-if="drafts[key]?.enabled">
          <div class="recording-grid">
            <label class="recording-field">
              <span>{{ recordingGovernanceText("义务", "Obligation") }}</span>
              <select v-model="drafts[key].obligation" :disabled="!editing" @change="markDirty">
                <option value="optional">{{ recordingObligationName("optional") }}</option>
                <option v-if="requiredObligationCategories.has(key)" value="required_before_effect">
                  {{ recordingObligationName("required_before_effect") }}
                </option>
              </select>
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("汇集引用", "Sink reference") }}</span>
              <input v-model="drafts[key].sinkRef" type="text" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("字段白名单（每行一个）", "Field allowlist (one per line)") }}</span>
              <textarea v-model="drafts[key].fieldAllowText" rows="3" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("字段脱敏（每行一个）", "Field redactions (one per line)") }}</span>
              <textarea v-model="drafts[key].fieldRedactText" rows="3" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("事件白名单（每行一个）", "Event allowlist (one per line)") }}</span>
              <textarea v-model="drafts[key].eventAllowText" rows="3" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("读取角色（每行一个）", "Reader roles (one per line)") }}</span>
              <textarea v-model="drafts[key].readerRolesText" rows="2" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("配置角色（每行一个）", "Configurer roles (one per line)") }}</span>
              <textarea v-model="drafts[key].configurerRolesText" rows="2" :disabled="!editing" @input="markDirty" />
            </label>
          </div>
          <div class="recording-grid recording-budgets">
            <label class="recording-field">
              <span>{{ recordingGovernanceText("最长保留秒数", "Max retention seconds") }}</span>
              <input v-model="drafts[key].retentionMaxAgeSeconds" type="number" min="1" max="31536000" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("最大记录数", "Max records") }}</span>
              <input v-model="drafts[key].retentionMaxRecords" type="number" min="1" max="1000000" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("最大内容字节", "Max content bytes") }}</span>
              <input v-model="drafts[key].retentionMaxContentBytes" type="number" min="0" max="1073741824" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("最大索引字节", "Max index bytes") }}</span>
              <input v-model="drafts[key].retentionMaxIndexBytes" type="number" min="1" max="1073741824" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("最大缓冲记录", "Max buffered records") }}</span>
              <input v-model="drafts[key].capacityMaxBufferedRecords" type="number" min="1" max="65536" :disabled="!editing" @input="markDirty" />
            </label>
            <label class="recording-field">
              <span>{{ recordingGovernanceText("单条最大字节", "Max record bytes") }}</span>
              <input v-model="drafts[key].capacityMaxRecordBytes" type="number" min="1" max="262144" :disabled="!editing" @input="markDirty" />
            </label>
          </div>
        </template>
        <p v-else class="recording-note">
          {{ recordingGovernanceText(
            "该类已停用：不采集、不序列化、不入队任何数据；已采集的记录按既有保留策略结算，不会被静默删除。",
            "Category disabled: nothing is collected, serialized, or enqueued; previously captured records settle under their retention policy and are not silently deleted.") }}
        </p>
      </article>
    </section>

    <section class="surface-card">
      <div class="section-header">
        <div>
          <h4>{{ recordingGovernanceText("未完成的录入义务", "Pending Recording Obligations") }}</h4>
          <p class="recording-note">
            {{ recordingGovernanceText(
              "以下为仍然欠缺的录制义务。类别停用后未完成的已受理审计属于限制而非已完成历史。",
              "Outstanding recording obligations. Admitted audits left incomplete after a category is disabled are a limitation, not completed history.") }}
          </p>
        </div>
        <div class="section-tags">
          <span>{{ recordingGovernanceText("待结算", "Pending") }} {{ pendingObligations.length }}</span>
          <span>{{ recordingGovernanceText("停用受限", "Disabled-pending") }} {{ incompleteObligations.length }}</span>
        </div>
      </div>
      <table v-if="pendingObligations.length" class="recording-table">
        <thead>
          <tr>
            <th>{{ recordingGovernanceText("操作", "Operation") }}</th>
            <th>{{ recordingGovernanceText("类别", "Category") }}</th>
            <th>{{ recordingGovernanceText("义务", "Obligation") }}</th>
            <th>{{ recordingGovernanceText("策略修订", "Policy Revision") }}</th>
            <th>{{ recordingGovernanceText("原因", "Reason") }}</th>
            <th>{{ recordingGovernanceText("时间", "Created") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in pendingObligations" :key="`${entry.operationRef}:${entry.category}`">
            <td>{{ entry.operationRef }}</td>
            <td>{{ recordingCategoryName(entry.category) }}</td>
            <td>{{ recordingObligationName(entry.obligation) }}</td>
            <td>{{ entry.policyRevision }}</td>
            <td>{{ recordingPendingReasonName(entry.reason) }}</td>
            <td>{{ entry.createdAt }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="recording-note">
        {{ recordingGovernanceText("没有未完成的录制义务。", "No outstanding recording obligations.") }}
      </p>
    </section>
  </section>
</template>

<style scoped>
.recording-governance-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.recording-categories {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.recording-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.recording-facts div {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.recording-facts dt {
  color: var(--console-ink-secondary);
  font-size: var(--text-base);
}

.recording-facts dd {
  margin: 0;
  font-weight: 600;
}

.recording-note {
  color: var(--console-ink-secondary);
  font-size: var(--text-base);
  margin: var(--space-2) 0 0;
}

.recording-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.recording-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.recording-field span {
  color: var(--console-ink-secondary);
  font-size: var(--text-base);
}

.recording-field textarea,
.recording-field input,
.recording-field select {
  width: 100%;
}

.recording-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.recording-table {
  width: 100%;
  border-collapse: collapse;
}

.recording-table th,
.recording-table td {
  text-align: left;
  padding: var(--space-2);
  border-bottom: 1px solid var(--console-rule);
  font-size: var(--text-base);
}
</style>
