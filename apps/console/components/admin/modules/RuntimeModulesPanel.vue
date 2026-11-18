<script setup lang="ts">
import RuntimeModuleGroup from "./RuntimeModuleGroup.vue";
import { useModulesViewContext } from "../../../composables/modulesViewContext";

const {
  isBusy,
  consoleState,
  enabledMountCount,
  gatewayChannels,
  gatewayChannelBusy,
  moduleGroups,
  reloadModules,
  saveMountModules,
  totalMountCount,
} = useModulesViewContext();
const downstream = gatewayChannels.downstream;
const upstream = gatewayChannels.upstream;
</script>

<template>
  <section class="modules-layout">
    <article class="surface-card module-mount-card gateway-channel-card">
      <div class="module-card-meta module-card-meta-right">
        <div>
          <h3 class="module-card-title">Gateway 通道</h3>
          <p class="mount-config-description">
            下游和上游分别选择内置通道或已启用插件提供的通道。启用插件只增加可选项，不会自动改变流量。
          </p>
        </div>
        <div class="module-card-header-actions">
          <div class="section-tags"><span>分方向切换</span><span>无隐式回退</span></div>
        </div>
      </div>
      <div class="mount-config-controls gateway-channel-controls">
        <label class="module-field">
          <span>下游 Gateway</span>
          <select v-model="downstream.draft.value" :disabled="gatewayChannelBusy">
            <option v-for="channelId in downstream.available.value" :key="channelId" :value="channelId">{{ channelId }}</option>
          </select>
          <small>当前 {{ downstream.selected.value }} · 代次 {{ downstream.generation.value }}</small>
        </label>
        <label class="module-field">
          <span>上游 Gateway</span>
          <select v-model="upstream.draft.value" :disabled="gatewayChannelBusy">
            <option v-for="channelId in upstream.available.value" :key="channelId" :value="channelId">{{ channelId }}</option>
          </select>
          <small>当前 {{ upstream.selected.value }} · 代次 {{ upstream.generation.value }}</small>
        </label>
        <div class="mount-config-actions">
          <button
            class="tool-button tool-button-ghost"
            type="button"
            :disabled="gatewayChannelBusy || !downstream.changed.value"
            @click="downstream.select({ direction: 'downstream', channelId: downstream.draft.value, expectedGeneration: downstream.generation.value })"
          >应用下游通道</button>
          <button
            class="tool-button"
            type="button"
            :disabled="gatewayChannelBusy || !upstream.changed.value"
            @click="upstream.select({ direction: 'upstream', channelId: upstream.draft.value, expectedGeneration: upstream.generation.value })"
          >{{ gatewayChannelBusy ? "切换中" : "应用上游通道" }}</button>
        </div>
      </div>
    </article>

    <article class="surface-card module-mount-card">
      <div class="module-card-meta module-card-meta-right">
        <h3 class="module-card-title">外置模块</h3>
        <div class="module-card-header-actions">
          <div class="section-tags">
            <span>运行代次 {{ consoleState?.runtime?.mountGeneration || 0 }}</span>
            <span>启用 {{ enabledMountCount }}/{{ totalMountCount }}</span>
          </div>
          <div class="module-actions">
            <button
              class="tool-button tool-button-ghost"
              type="button"
              :disabled="isBusy('module-reload')"
              :aria-busy="isBusy('module-reload')"
              @click="reloadModules()"
            >
              {{ isBusy("module-reload") ? "重载中" : "重载模块" }}
            </button>
            <button
              class="tool-button"
              type="button"
              :disabled="isBusy('mounts')"
              :aria-busy="isBusy('mounts')"
              @click="saveMountModules()"
            >
              {{ isBusy("mounts") ? "保存中" : "保存配置" }}
            </button>
          </div>
        </div>
      </div>

      <div class="mount-config-list">
        <RuntimeModuleGroup
          v-for="group in moduleGroups"
          :key="group.id"
          :group="group"
        />
      </div>
    </article>
  </section>
</template>
