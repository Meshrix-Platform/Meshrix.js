<script setup lang="ts">
import RuntimeModuleGroup from "./RuntimeModuleGroup.vue";
import { useModulesViewContext } from "../../../composables/modulesViewContext";

const {
  isBusy,
  consoleState,
  enabledMountCount,
  externalGateway,
  externalGatewayBusy,
  moduleGroups,
  reloadModules,
  saveMountModules,
  totalMountCount,
} = useModulesViewContext();
const externalGatewayMode = externalGateway.activeMode;
const externalGatewayGeneration = externalGateway.generation;
const externalGatewayAdapterDraft = externalGateway.adapterDraft;
const externalGatewayPublicBaseUrlDraft = externalGateway.publicBaseUrlDraft;
</script>

<template>
  <section class="modules-layout">
    <article class="surface-card module-mount-card external-gateway-card">
      <div class="module-card-meta module-card-meta-right">
        <div>
          <h3 class="module-card-title">外置网关</h3>
          <p class="mount-config-description">
            让 Caddy、Nginx 等边缘代理负责负载均衡、通用限流与健康选择；身份、授权、审批、业务配额和审计仍由平台执行。
          </p>
        </div>
        <div class="module-card-header-actions">
          <div class="section-tags">
            <span>{{ externalGatewayMode === "external" ? "External" : "Direct" }}</span>
            <span>代次 {{ externalGatewayGeneration }}</span>
          </div>
        </div>
      </div>
      <div class="mount-config-controls">
        <label class="module-field">
          <span>外置网关适配器</span>
          <select v-model="externalGatewayAdapterDraft" :disabled="externalGatewayBusy">
            <option value="caddy">Caddy</option>
            <option value="nginx">Nginx</option>
          </select>
        </label>
        <label class="module-field">
          <span>外置网关访问地址</span>
          <input
            v-model="externalGatewayPublicBaseUrlDraft"
            autocomplete="off"
            inputmode="url"
            placeholder="https://gateway.example.com 或 http://网关IP:7330"
          />
          <small>填写下游 MCP 客户端实际访问的 IP 地址或域名；启用前会验证健康状态、平台身份、网关转发和 MCP 协议。</small>
        </label>
        <div class="mount-config-actions">
          <button
            class="tool-button tool-button-ghost"
            type="button"
            :disabled="externalGatewayBusy || externalGatewayMode === 'direct'"
            @click="externalGateway.switchDirect(externalGatewayGeneration)"
          >使用内置网关</button>
          <button
            class="tool-button"
            type="button"
            :disabled="externalGatewayBusy"
            @click="externalGateway.apply({
              expectedGeneration: externalGatewayGeneration,
              mode: 'external',
              adapterId: externalGatewayAdapterDraft,
              publicBaseUrl: externalGatewayPublicBaseUrlDraft,
            })"
          >{{ externalGatewayBusy ? "验证中" : "验证并启用" }}</button>
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
