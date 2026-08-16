<script setup lang="ts">
import { Check } from "@element-plus/icons-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, resolveComponent, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import BrowseSelectButton from "../../components/BrowseSelectButton.vue";
import ConsoleDescriptionList from "../../components/ConsoleDescriptionList.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import FeatureToggle from "../../components/FeatureToggle.vue";
import JsonConfigFileEditor from "../../components/JsonConfigFileEditor.vue";
import MultiChoiceCardGroup from "../../components/MultiChoiceCardGroup.vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import StatusPill from "@meshrix/ui-console/status-pill";
import { useConsoleApiKeyDistributionController } from "../../composables/console-api-key-distribution-controller";
import { apiKeyDistributionText, apiKeyStatusText } from "../../i18n/api-key-distribution";
import {
  organizationGovernanceHierarchyRank,
  organizationGovernanceNodeName,
  organizationGovernanceNodeType,
} from "../../i18n/organization-governance";
import type { ApiKeyRecord } from "../../lib/api-key-distribution-client";
import "../../styles/views/api-key-distribution.css";

import { consoleMessages, currentConsoleLocale, localizeConsoleText } from "../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

defineOptions({ name: "ApiKeyDistributionView" });

const {
  applyProfile, busy, connectorSnippet, copied, copyConnectorSnippet, copySecret, create,
  creating, dataClassificationOptions, dismissSecret, draft, draftConfigDocument,
  draftMissingHints, draftValid, eligible, error, importDraftConfig, inferredSummaryItems,
  loading, maximumRiskOptions, mutatingKeyId, nodes, oneTimeSecret, profileOptions, records,
  refresh, revealedRecord, revoke, rotate, scopes, snippetCopied, status, targetOptions,
  toolsetOptions,
} = useConsoleApiKeyDistributionController();

const t = apiKeyDistributionText;
const msg = computed(() => consoleMessages[currentConsoleLocale.value]);
// Resolved through the app registry instead of a module import: consumers that
// stub vue-router (tests) keep rendering without the links.
const RouterLink: any = resolveComponent("RouterLink");
const revealCopyButton = ref<HTMLButtonElement | null>(null);
let revealReturnFocus: HTMLElement | null = null;

const setupStep = ref(1);
const setupSteps = computed(() => [
  { id: 1, label: t("选择 Agent", "Choose Agent"), hint: t("目标与身份", "Target and identity") },
  { id: 2, label: t("选择能力", "Choose Access"), hint: t("工具与资源", "Tools and resources") },
  { id: 3, label: t("确认连接", "Review"), hint: t("检查后生成", "Review and generate") },
]);
const agentStepReady = computed(() => Boolean(
  draft.value.selectedTargetIds.length
  && draft.value.workloadDisplayName.trim()
  && draft.value.organizationNodeId
  && draft.value.expiresAt
  && Number.isFinite(Date.parse(draft.value.expiresAt))
  && Date.parse(draft.value.expiresAt) > Date.now()
));
const accessStepReady = computed(() => Boolean(
  draft.value.selectedToolsetIds.length && draft.value.allowedTools.length
));
const selectedAgentLabels = computed(() => targetOptions.value
  .filter((option) => draft.value.selectedTargetIds.includes(option.value))
  .map((option) => option.label));
const selectedToolsetLabels = computed(() => toolsetOptions.value
  .filter((option) => draft.value.selectedToolsetIds.includes(option.value))
  .map((option) => option.label));

function canOpenSetupStep(step: number): boolean {
  if (step <= 1) return true;
  if (step === 2) return agentStepReady.value;
  return agentStepReady.value && accessStepReady.value;
}

function openSetupStep(step: number): void {
  if (canOpenSetupStep(step)) setupStep.value = step;
}

function selectAgentTarget(event: Event): void {
  const targetId = event.target instanceof HTMLSelectElement ? event.target.value : "";
  draft.value.selectedTargetIds = targetId ? [targetId] : [];
}

// Reveal state machine: revealed -> acknowledged -> dismissed. The
// acknowledgement is a deliberate click, never a timer.
const revealAcknowledged = ref(false);
const revealNavigationReminder = ref(false);

// Any change to the reveal resets the acknowledgement. The watch never reads
// the plaintext value, which stays in the controller's ephemeral ref only.
watch(oneTimeSecret, () => {
  revealAcknowledged.value = false;
  revealNavigationReminder.value = false;
});

// Leaving while an unacknowledged reveal is open stays on the page and
// surfaces an inline reminder (never a native dialog). Acknowledging or
// discarding releases the guard.
onBeforeRouteLeave(() => {
  if (oneTimeSecret.value && !revealAcknowledged.value) {
    revealNavigationReminder.value = true;
    return false;
  }
  return true;
});

const levelOptions = computed(() =>
  [...nodes.value].sort((left, right) => {
    const rankDelta = organizationGovernanceHierarchyRank(left.nodeId, left.name)
      - organizationGovernanceHierarchyRank(right.nodeId, right.name);
    if (rankDelta !== 0) return rankDelta;
    return organizationGovernanceNodeName(left.nodeId, left.name)
      .localeCompare(organizationGovernanceNodeName(right.nodeId, right.name), "zh");
  }),
);

function levelLabel(nodeId: string, fallback = ""): string {
  const node = nodes.value.find((entry) => entry.nodeId === nodeId);
  const nodeFallback = fallback || node?.name || nodeId;
  const localized = organizationGovernanceNodeName(nodeId, nodeFallback);
  if (localized !== nodeFallback) return localized;
  const nodeType = node?.nodeType;
  const byType = nodeType ? organizationGovernanceNodeType(nodeType) : "";
  return byType && byType !== nodeType ? byType : localized;
}

function organizationName(record: ApiKeyRecord): string {
  const fallback = record.organizationBreadcrumb?.length
    ? record.organizationBreadcrumb[record.organizationBreadcrumb.length - 1]
    : record.organizationNodeId;
  return levelLabel(record.organizationNodeId, fallback || record.organizationNodeId);
}

function policySummary(record: ApiKeyRecord): string {
  const policy = record.policy;
  return t(
    `${policy.allowedTools.length} 个工具 · 风险上限 ${policy.maximumRisk} · ${policy.resources.mode === "unrestricted" ? "全部资源" : "限定资源"}`,
    `${policy.allowedTools.length} tools · ${policy.maximumRisk} risk ceiling · ${policy.resources.mode === "unrestricted" ? "all resources" : "restricted resources"}`,
  );
}

function processIdentitySummary(record: ApiKeyRecord): string {
  return record.policy.processIdentity.mode === "required"
    ? t("必须同时提供预先登记且签名有效的进程身份。", "A pre-registered, valid signed process identity is also required.")
    : t("仅凭密钥即可代表该工作负载；进程身份只作为附加证据。", "Possession alone represents this workload; process identity is only additional evidence.");
}

function formatCallsPerMinute(record: ApiKeyRecord): string {
  const { requestsPerWindow, windowSeconds } = record.policy.limits;
  if (!Number.isFinite(requestsPerWindow) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return String(requestsPerWindow ?? "");
  }
  if (windowSeconds === 60) return String(requestsPerWindow);
  const perMinute = Math.max(1, Math.round((requestsPerWindow * 60) / windowSeconds));
  return t(
    `${perMinute}（原 ${requestsPerWindow}/${windowSeconds}s）`,
    `${perMinute} (from ${requestsPerWindow}/${windowSeconds}s)`,
  );
}

async function runRevealAction(event: MouseEvent, action: () => Promise<void>): Promise<void> {
  const origin = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  revealReturnFocus = null;
  await action();
  if (!oneTimeSecret.value) return;
  revealReturnFocus = origin;
  await nextTick();
  revealCopyButton.value?.focus();
}

async function createAndFocusReveal(event: MouseEvent): Promise<void> {
  await runRevealAction(event, create);
}

async function rotateAndFocusReveal(event: MouseEvent, record: ApiKeyRecord): Promise<void> {
  await runRevealAction(event, () => rotate(record));
}

async function dismissSecretAndRestoreFocus(): Promise<void> {
  // Dismissal is gated on the explicit storage acknowledgement.
  if (!revealAcknowledged.value) return;
  const returnTarget = revealReturnFocus;
  revealReturnFocus = null;
  dismissSecret(true);
  await nextTick();
  if (returnTarget?.isConnected) returnTarget.focus();
}

async function discardSecretAndRestoreFocus(): Promise<void> {
  const returnTarget = revealReturnFocus;
  revealReturnFocus = null;
  // Discard without storing clears the plaintext and releases the route guard.
  dismissSecret();
  status.value = msg.value.secretReveal.discarded;
  await nextTick();
  if (returnTarget?.isConnected) returnTarget.focus();
}

async function importDraftConfigFiles(files: File[]): Promise<void> {
  const file = files[0];
  if (!file) return;
  try {
    importDraftConfig(JSON.parse(await file.text()));
  } catch (caught) {
    error.value = caught instanceof Error
      ? caught.message
      : t("无法解析 JSON 配置文件。", "Could not parse the JSON config file.");
  }
}

async function refreshPage(): Promise<boolean> {
  revealReturnFocus = null;
  return refresh();
}

onMounted(() => void refreshPage());
onBeforeUnmount(() => {
  revealReturnFocus = null;
  dismissSecret();
});
usePageRefreshHandler(
  (detail) => detail.viewId === "admin" && detail.adminView === "apiKeyDistribution",
  refreshPage,
);
</script>

<template>
  <section class="api-key-distribution-layout">
    <header class="section-header api-key-distribution-header">
      <div>
        <span class="api-key-page-eyebrow">{{ t("Agent MCP 接入", "Agent MCP access") }}</span>
        <h2>{{ t("连接一个 Agent", "Connect an Agent") }}</h2>
        <p>{{ t("选择 Agent、需要的能力和使用范围，Meshrix.js 会生成受限的连接资料。签名、凭据保存与缓存细节由连接器处理。", "Choose an Agent, the access it needs, and its resource scope. Meshrix.js generates bounded connection details while the connector handles signing, credential storage, and cache details.") }}</p>
        <p class="journey-disambiguation" data-testid="journey-disambiguation">
          {{ msg.journey.clientKeyDecision }}
          <RouterLink to="/admin/operation-permission" class="journey-cross-link">
            {{ msg.journey.toolTokenLink }}
          </RouterLink>
        </p>
      </div>
    </header>

    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" tone="success">{{ status }}</ConsoleInlineAlert>

    <section v-if="loading" class="surface-card api-key-empty" aria-live="polite">
      {{ t("正在同步可管理范围和密钥记录…", "Syncing manageable scopes and key records…") }}
    </section>
    <section v-else-if="!scopes" class="surface-card api-key-empty" data-access="unavailable">
      <strong>{{ t("无法加载密钥分发数据", "Key distribution data could not be loaded") }}</strong>
      <p>{{ t("当前无法确认可管理范围。请稍后使用页面顶部的刷新操作重试。", "Manageable scopes cannot be confirmed right now. Try the page-level refresh action again later.") }}</p>
    </section>
    <section v-else-if="!eligible" class="surface-card api-key-empty" data-access="restricted-empty">
      <strong>{{ t("当前账号没有可管理的组织范围", "No manageable organization scope") }}</strong>
      <p>{{ t("页面不会推断全局权限。请由组织权限管理员分配明确的密钥管理范围。", "This page does not infer global authority. Ask an organization administrator to assign an explicit key-management scope.") }}</p>
    </section>

    <template v-else>
      <section v-if="oneTimeSecret" class="surface-card api-key-reveal" role="region" aria-live="assertive" :aria-label="t('一次性密钥', 'One-time key')">
        <div>
          <span class="api-key-eyebrow">{{ t("最后一步，仅显示这一次", "Final step, shown only this time") }}</span>
          <h3>{{ t("保存连接资料", "Save the connection details") }}</h3>
          <p class="api-key-reveal-agent">{{ revealedRecord?.workloadDisplayName }}</p>
          <p>{{ revealedRecord ? processIdentitySummary(revealedRecord) : "" }}</p>
          <p v-if="revealedRecord?.policy.processIdentity.mode === 'optional'">{{ t("这是持有者凭证。若密钥被盗，攻击者可在其权限范围内冒用记录的工作负载身份。", "This is a bearer credential. If stolen, an attacker can impersonate the recorded workload identity within its permissions.") }}</p>
          <p v-else>{{ t("单独窃取密钥不足以通过进程校验；若密钥与受信任进程签名材料同时泄露，攻击者仍可在权限范围内冒用该身份。", "The key alone cannot pass process verification. If both the key and trusted process-signing material are stolen, an attacker can still impersonate the identity within its permissions.") }}</p>
        </div>
        <output class="api-key-secret" data-one-time-secret>{{ oneTimeSecret }}</output>
        <label data-testid="api-key-reveal-confirm">
          <input v-model="revealAcknowledged" type="checkbox" />
          <span>{{ msg.secretReveal.storedConfirm }}</span>
        </label>
        <p>{{ msg.secretReveal.discardConsequence }}</p>
        <ConsoleInlineAlert
          v-if="revealNavigationReminder && !revealAcknowledged"
          tone="danger"
          data-testid="api-key-reveal-navigation-reminder"
        >
          {{ msg.secretReveal.navigationReminder }}
        </ConsoleInlineAlert>
        <div class="horizontal-action-group api-key-reveal-actions">
          <button ref="revealCopyButton" class="primary-action" type="button" data-testid="api-key-reveal-copy" @click="copySecret">
            {{ copied ? t("已复制", "Copied") : t("复制密钥", "Copy Key") }}
          </button>
          <button class="table-action" type="button" data-testid="api-key-reveal-dismiss" :disabled="!revealAcknowledged" @click="dismissSecretAndRestoreFocus">
            {{ t("关闭且不再显示", "Dismiss Permanently") }}
          </button>
          <button class="table-action api-key-danger-action" type="button" data-testid="api-key-reveal-discard" @click="discardSecretAndRestoreFocus">
            {{ msg.secretReveal.discard }}
          </button>
        </div>
        <section
          v-if="oneTimeSecret"
          class="api-key-connector-snippet"
          data-testid="api-key-connector-snippet"
          :aria-label="msg.journey.snippetTitle"
        >
          <h4>{{ msg.journey.snippetTitle }}</h4>
          <template v-if="connectorSnippet">
            <p class="api-key-connector-snippet-note">{{ msg.journey.snippetSecretNote }}</p>
            <pre class="api-key-connector-snippet-code">{{ connectorSnippet }}</pre>
            <button
              class="table-action"
              type="button"
              data-testid="api-key-connector-snippet-copy"
              @click="copyConnectorSnippet"
            >
              {{ snippetCopied ? msg.journey.snippetCopied : msg.journey.snippetCopy }}
            </button>
          </template>
          <p v-else class="api-key-connector-snippet-guidance" data-testid="api-key-connector-snippet-guidance">
            {{ msg.journey.snippetGuidance }}
          </p>
        </section>
      </section>

      <section v-if="!oneTimeSecret" class="surface-card api-key-create-card api-key-setup-card" data-testid="api-key-distribution-workspace">
        <div class="section-header api-key-setup-header">
          <div>
            <span class="api-key-step-kicker">{{ t("快速接入", "Quick setup") }}</span>
            <h3>{{ t("三步完成 Agent MCP 接入", "Connect Agent MCP in three steps") }}</h3>
            <p>{{ t("常用选项在主流程中完成；只有需要精细限制时才展开高级设置。", "Complete the common choices in the main flow. Open advanced settings only when you need finer limits.") }}</p>
          </div>
        </div>

        <nav class="api-key-setup-steps" :aria-label="t('Agent 接入步骤', 'Agent setup steps')">
          <button
            v-for="step in setupSteps"
            :key="step.id"
            type="button"
            class="api-key-setup-step"
            :class="{ active: setupStep === step.id, complete: setupStep > step.id }"
            :disabled="busy || !canOpenSetupStep(step.id)"
            :aria-current="setupStep === step.id ? 'step' : undefined"
            :data-testid="`agent-setup-step-${step.id}`"
            @click="openSetupStep(step.id)"
          >
            <span class="api-key-step-number">
              <Check v-if="setupStep > step.id" class="api-key-step-check" aria-hidden="true" />
              <template v-else>{{ step.id }}</template>
            </span>
            <span><strong>{{ step.label }}</strong><small>{{ step.hint }}</small></span>
          </button>
        </nav>

        <section v-show="setupStep === 1" class="api-key-step-panel" data-testid="agent-setup-agent-step">
          <div class="api-key-step-intro">
            <span>01</span>
            <div><h4>{{ t("这个连接给谁使用？", "Who will use this connection?") }}</h4><p>{{ t("先选择 Agent，再给这条连接一个便于识别的名称。", "Choose the Agent first, then give this connection a recognizable name.") }}</p></div>
          </div>
          <div class="api-key-form-grid">
            <label><span>{{ t("Agent", "Agent") }}</span>
              <select :value="draft.selectedTargetIds[0] || ''" :disabled="busy" data-testid="agent-target-select" @change="selectAgentTarget">
                <option value="">{{ t("选择一个 Agent", "Choose an Agent") }}</option>
                <option v-for="option in targetOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label><span>{{ t("连接名称", "Connection name") }}</span><input v-model.trim="draft.workloadDisplayName" :disabled="busy" autocomplete="off" :placeholder="t('例如：团队开发 Agent', 'For example: Team development Agent')" /></label>
            <label><span>{{ t("所属团队或组织", "Owning team or organization") }}</span>
              <select v-model="draft.organizationNodeId" :disabled="busy">
                <option value="">{{ t("请选择所属层级", "Select an owning level") }}</option>
                <option v-for="node in levelOptions" :key="node.nodeId" :value="node.nodeId">{{ levelLabel(node.nodeId, node.name) }}</option>
              </select>
            </label>
            <label><span>{{ t("有效期至", "Expires at") }}</span><input v-model="draft.expiresAt" type="datetime-local" :disabled="busy" /></label>
          </div>
          <div class="api-key-step-actions">
            <button class="primary-action" type="button" :disabled="busy || !agentStepReady" @click="openSetupStep(2)">{{ t("下一步：选择能力", "Next: choose access") }}</button>
          </div>
        </section>

        <section v-show="setupStep === 2" class="api-key-step-panel" data-testid="agent-setup-access-step">
          <div class="api-key-step-intro">
            <span>02</span>
            <div><h4>{{ t("这个 Agent 可以做什么？", "What can this Agent do?") }}</h4><p>{{ t("选择工具集即可，具体工具、服务与权限范围会自动推导。", "Choose toolsets; tools, services, and scopes are derived automatically.") }}</p></div>
          </div>
          <div class="api-key-profile-picker">
            <span>{{ t("从权限档案开始（可选）", "Start from a permission profile (optional)") }}</span>
            <OptionBar
              :model-value="draft.selectedProfileId"
              :options="profileOptions"
              :placeholder="t('不使用档案', 'No profile')"
              :disabled="busy"
              @update:model-value="(value) => applyProfile(String(value ?? ''))"
            />
          </div>
          <MultiChoiceCardGroup
            v-model="draft.selectedToolsetIds"
            :options="toolsetOptions"
            :title="t('可用能力', 'Available access')"
            :summary="t('至少选择一个工具集。', 'Select at least one toolset.')"
            :select-all-label="t('允许使用所有工具', 'Allow all tools')"
            :disabled="busy"
            layout="list"
          />

          <details class="api-key-policy-section api-key-advanced-settings">
            <summary>{{ t("高级设置", "Advanced settings") }} <span>{{ t("资源、风险、调用限制与 JSON", "Resources, risk, call limits, and JSON") }}</span></summary>
            <div class="api-key-advanced-grid">
              <FeatureToggle
                v-model="draft.resourcesUnrestricted"
                :disabled="busy"
                :label="t('允许访问全部资源', 'Allow all resources')"
                :on-label="t('全部资源', 'All resources')"
                :off-label="t('限定资源', 'Restricted')"
              />
              <div v-if="!draft.resourcesUnrestricted" class="api-key-resource-limits">
                <MultiChoiceCardGroup
                  v-model="draft.selectedDataClassifications"
                  :options="dataClassificationOptions"
                  :title="t('数据分类', 'Data Classifications')"
                  :summary="t('可选。限制密钥可触及的数据分级。', 'Optional. Limit which data classifications this key may touch.')"
                  :select-all-label="t('允许全部分类', 'Allow all classifications')"
                  :disabled="busy"
                  layout="list"
                />
                <label>
                  <span>{{ t("工作空间 ID", "Workspace IDs") }}</span>
                  <textarea v-model="draft.workspaceIds" :disabled="busy" :placeholder="t('可选，每行一个', 'Optional, one per line')" />
                </label>
              </div>
              <div class="api-key-form-grid">
                <label><span>{{ t("最高风险级别", "Maximum Risk") }}</span>
                  <select v-model="draft.maximumRisk" :disabled="busy">
                    <option v-for="option in maximumRiskOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                </label>
                <label>
                  <span>{{ t("每分钟调用次数", "Calls per minute") }}</span>
                  <input v-model.number="draft.requestsPerMinute" type="number" min="1" :disabled="busy" :placeholder="t('留空不限制', 'Empty = unlimited')" />
                </label>
                <label>
                  <span>{{ t("最大并发量", "Maximum concurrency") }}</span>
                  <input v-model.number="draft.maxConcurrentEffects" type="number" min="1" :disabled="busy" :placeholder="t('留空不限制', 'Empty = unlimited')" />
                </label>
              </div>
              <div class="api-key-import-row">
                <BrowseSelectButton
                  kind="local-files"
                  accept="application/json,.json"
                  :multiple="false"
                  :disabled="busy"
                  :button-text="t('导入 JSON 文件', 'Import JSON File')"
                  @select="importDraftConfigFiles"
                />
              </div>
              <JsonConfigFileEditor
                :title="t('从 JSON 配置写入表单', 'Fill form from JSON config')"
                :subtitle="t('粘贴草稿字段或创建请求形状的 JSON，应用后写入表单；不会直接创建连接。', 'Paste draft fields or a create-request shaped JSON. Apply fills the form; it does not create a connection.')"
                file-key="api-key-distribution:create-draft"
                :model-value="draftConfigDocument"
                :rows="12"
                :cancel-label="t('取消', 'Cancel')"
                :save-label="t('应用到表单', 'Apply to Form')"
                :on-save="importDraftConfig"
                :open="false"
              />
            </div>
          </details>
          <div class="api-key-step-actions split">
            <button class="table-action" type="button" :disabled="busy" @click="openSetupStep(1)">{{ t("上一步", "Back") }}</button>
            <button class="primary-action" type="button" :disabled="busy || !accessStepReady" @click="openSetupStep(3)">{{ t("下一步：确认连接", "Next: review") }}</button>
          </div>
        </section>

        <section v-show="setupStep === 3" class="api-key-step-panel" data-testid="agent-setup-review-step">
          <div class="api-key-step-intro">
            <span>03</span>
            <div><h4>{{ t("确认后生成连接资料", "Review and generate connection details") }}</h4><p>{{ t("连接资料只显示一次；Agent 的每次调用仍由服务端权限策略决定。", "Connection details are shown once. Every Agent call remains subject to server-side policy.") }}</p></div>
          </div>
          <div class="api-key-review-summary">
            <div><span>{{ t("Agent", "Agent") }}</span><strong>{{ selectedAgentLabels.join(t("、", ", ")) || t("未选择", "Not selected") }}</strong></div>
            <div><span>{{ t("能力", "Access") }}</span><strong>{{ selectedToolsetLabels.join(t("、", ", ")) || t("未选择", "Not selected") }}</strong></div>
            <div><span>{{ t("资源", "Resources") }}</span><strong>{{ draft.resourcesUnrestricted ? t("全部资源", "All resources") : t("限定资源", "Restricted resources") }}</strong></div>
          </div>
          <div class="api-key-trust-summary">
            <strong>{{ t("接下来由系统处理", "Handled for you") }}</strong>
            <ul>
              <li>{{ t("生成仅用于所选 Agent、组织和能力的受限凭据。", "Generate a credential bounded to the selected Agent, organization, and access.") }}</li>
              <li>{{ t("连接器把凭据保存在私有存储中，Agent 配置不包含明文。", "Store the credential in the connector's private store; Agent configuration contains no plaintext.") }}</li>
              <li>{{ t("每次调用继续经过 Operation Permission，不因接入而扩大权限。", "Keep every call behind Operation Permission without expanding authority.") }}</li>
            </ul>
          </div>
          <details class="api-key-inferred-summary">
            <summary>{{ t("查看自动推导的技术范围", "View derived technical scope") }}</summary>
            <ConsoleDescriptionList :items="inferredSummaryItems" :columns="2" />
          </details>

          <div class="api-key-create-actions">
            <p v-if="!draftValid && draftMissingHints.length" class="api-key-create-missing">
              {{ t("还需填写：", "Still needed: ") }}{{ draftMissingHints.join(t("、", ", ")) }}
            </p>
            <div class="api-key-step-actions split">
              <button class="table-action" type="button" :disabled="busy" @click="openSetupStep(2)">{{ t("上一步", "Back") }}</button>
              <button class="primary-action" type="button" :disabled="busy || !draftValid" @click="createAndFocusReveal">
                {{ creating ? t("正在生成…", "Generating…") : t("生成连接资料", "Generate connection details") }}
              </button>
            </div>
          </div>
        </section>
      </section>

      <section class="surface-card api-key-list-card">
        <div class="section-header"><div><h3>{{ t("连接管理", "Connection management") }}</h3><p>{{ t("这里管理已生成的 Agent 接入凭据，只显示经过遮盖的记录。不存在再次查看、导出、恢复或归档操作。", "Manage generated Agent access credentials here. Only redacted records appear; there is no reveal-again, export, restore, or archive action.") }}</p></div></div>
        <div v-if="!records.length" class="api-key-empty">{{ t("当前范围内还没有密钥。", "There are no keys in the current scope.") }}</div>
        <article v-for="record in records" :key="record.keyId" class="api-key-record" :data-status="record.status">
          <div class="api-key-record-heading">
            <div><h4>{{ record.workloadDisplayName }}</h4><p>{{ organizationName(record) }}</p></div>
            <StatusPill :label="localizeStatusPillLabel(apiKeyStatusText(record.status))" :tone="record.status === 'active' ? 'success' : record.status === 'revoked' ? 'danger' : 'warning'" />
          </div>
          <dl class="api-key-metadata">
            <div><dt>{{ t("记录的工作负载身份", "Recorded Workload Identity") }}</dt><dd>{{ record.workloadPrincipalId }}</dd></div>
            <div><dt>{{ t("密钥标识", "Key Identifier") }}</dt><dd>{{ record.displayPrefix }} · {{ record.credentialFingerprint }}</dd></div>
            <div><dt>{{ t("权限摘要", "Permission Summary") }}</dt><dd>{{ policySummary(record) }}</dd></div>
            <div><dt>{{ t("每分钟调用次数", "Calls per minute") }}</dt><dd>{{ formatCallsPerMinute(record) }}</dd></div>
            <div><dt>{{ t("最大并发量", "Maximum concurrency") }}</dt><dd>{{ record.policy.limits.maxConcurrentEffects }}</dd></div>
            <div><dt>{{ t("已使用次数", "Uses so far") }}</dt><dd>{{ record.useCount }}</dd></div>
            <div><dt>{{ t("到期时间", "Expires At") }}</dt><dd>{{ record.expiresAt }}</dd></div>
            <div><dt>{{ t("状态版本", "State Version") }}</dt><dd>{{ record.lifecycleRevision }}</dd></div>
          </dl>
          <div v-if="record.status === 'active'" class="horizontal-action-group api-key-record-actions">
            <button class="table-action" type="button" :disabled="busy" @click="rotateAndFocusReveal($event, record)">{{ mutatingKeyId === record.keyId ? t("处理中…", "Working…") : t("轮换密钥", "Rotate Key") }}</button>
            <button class="table-action api-key-danger-action" type="button" :disabled="busy" @click="revoke(record)">{{ t("永久撤销", "Revoke Permanently") }}</button>
          </div>
        </article>
      </section>
    </template>
  </section>
</template>
