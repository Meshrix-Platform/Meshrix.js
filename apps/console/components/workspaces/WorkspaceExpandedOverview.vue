<script setup lang="ts">
import ConfigFoldCard from "../ConfigFoldCard.vue";
import WorkspaceFileTree from "../WorkspaceFileTree.vue";
import { useWorkspacesViewContext } from "../../composables/workspacesViewContext";

const {
  chainData,
  contextData,
  formatCompactDate,
  selected,
  selectedId,
  selectedSession,
  sessionContextData,
  workspaceFilesData,
} = useWorkspacesViewContext();
</script>

<template>
  <template v-if="selected">
    <section v-if="chainData" class="module-panel workspace-chain-panel">
      <div class="module-panel-heading">
        <strong>继承链</strong>
        <span>{{ chainData.chain.length }} 级</span>
      </div>
      <div class="ws-chain">
        <span
          v-for="(item, i) in chainData.chain"
          :key="item.workspaceId"
          class="ws-chain-item"
          :class="{ 'is-current': item.workspaceId === selectedId }"
        >
          <span v-if="Number(i) > 0" class="ws-chain-arrow">›</span>
          <span>{{ item.title || item.workspaceId.slice(0, 12) }}</span>
        </span>
      </div>
    </section>

    <ConfigFoldCard v-if="sessionContextData && selectedSession" title="当前会话线程（切换工作状态）">
      <dl class="meta-list">
        <div><dt>会话 ID</dt><dd><code>{{ sessionContextData.agentSessionId }}</code></dd></div>
        <div><dt>事件数量</dt><dd>{{ sessionContextData.sessionEventCount }} 个</dd></div>
        <div><dt>父会话</dt><dd>{{ sessionContextData.parentSessionId || '（主线会话）' }}</dd></div>
        <div><dt>分叉事件</dt><dd>{{ sessionContextData.forkedFromEventId || '（无）' }}</dd></div>
      </dl>
      <div v-if="selectedSession.events.length" class="ws-session-events">
        <div
          v-for="event in selectedSession.events.slice(-6)"
          :key="event.eventId"
          class="ws-session-event"
        >
          <span>#{{ event.sequence }}</span>
          <strong>{{ event.title || event.type }}</strong>
          <small>{{ formatCompactDate(event.createdAt || "") }}</small>
        </div>
      </div>
    </ConfigFoldCard>

    <ConfigFoldCard v-if="contextData" title="解析后的运行上下文（智能体可直接使用）">
      <dl class="meta-list">
        <div><dt>上下文 Profile</dt><dd>{{ contextData.contextProfileId || '（未设置，使用默认）' }}</dd></div>
        <div><dt>工具 Grant</dt><dd>{{ contextData.toolGrantId || '（未设置，使用默认）' }}</dd></div>
        <div><dt>模型别名</dt><dd>{{ contextData.modelAlias || '（未设置，使用默认）' }}</dd></div>
      </dl>
    </ConfigFoldCard>

    <ConfigFoldCard title="本级 Profile（仅本工作空间自有的差异配置）">
      <pre class="config-json-preview">{{ JSON.stringify(selected.profile, null, 2) || '{}' }}</pre>
    </ConfigFoldCard>

    <ConfigFoldCard v-if="workspaceFilesData?.files" title="工作空间文件树（物理文件）">
      <WorkspaceFileTree :files="workspaceFilesData.files" />
    </ConfigFoldCard>
  </template>
</template>
