<script setup lang="ts">
import BinaryCheckbox from "@lico/ui-console/binary-checkbox";
import SplitToggleCard from "../../components/SplitToggleCard.vue";
import StatusPill from "../../components/StatusPill.vue";
import "./version-assembly/version-assembly.css";
import { useVersionAssemblyView } from "./version-assembly/useVersionAssemblyView";

const {
  architectureItems,
  architectureLayerGroups,
  hydratableArchitectureCount,
  foundationArchitectureCount,
  loadError,
  loading,
  nonHydratableArchitectureCount,
  runtimeEvidenceCount,
  runtimeEvidenceGroups,
  selectedArchitectureCount,
  selectedArchitectureComponentIds,
  selectedHydratableArchitectureCount,
  assemblyArtifact,
  assemblyError,
  buildingAssembly,
  canBuildRuntimeAssembly,
  architectureChildDetail,
  architectureNodeCount,
  architectureSubtreeToggleDisabled,
  architectureTreeRowStyle,
  categoryLabel,
  flattenArchitectureChildren,
  hydratableArchitectureNodeCount,
  hydrationLabel,
  isArchitectureComponentSelected,
  isArchitectureSubtreeSelected,
  isModuleExpanded,
  moduleSummaryText,
  selectedArchitectureNodeCount,
  setArchitectureComponentSelection,
  setArchitectureLayerSelection,
  setArchitectureSubtreeSelection,
  buildRuntimeAssemblyPackage,
  toggleModuleExpanded,
} = useVersionAssemblyView();
</script>

<template>
  <section class="version-assembly-layout" data-testid="version-assembly-view">
    <article class="surface-card version-assembly-hero">
      <div class="section-header">
        <div>
          <h3>版本装配</h3>
          <p>从内部架构事实源生成层级模块清单，并以架构模块作为唯一装配选择入口。</p>
          <p>装配选择只以架构模块为准；运行态发现仅作为校验依据。</p>
        </div>
        <StatusPill
          :tone="loading ? 'info' : loadError ? 'warning' : 'success'"
          :label="loading ? '同步中' : loadError ? '部分读取' : '已同步'"
        />
      </div>
      <div class="detail-metrics version-assembly-metrics">
        <div>
          <span>架构组件</span>
          <strong>{{ selectedArchitectureCount }} / {{ architectureItems.length }}</strong>
        </div>
        <div>
          <span>可脱水</span>
          <strong>{{ selectedHydratableArchitectureCount }} / {{ hydratableArchitectureCount }}</strong>
        </div>
        <div>
          <span>不可脱水</span>
          <strong>{{ nonHydratableArchitectureCount }}</strong>
        </div>
        <div>
          <span>基础模块</span>
          <strong>{{ foundationArchitectureCount }}</strong>
        </div>
        <div>
          <span>运行态证据</span>
          <strong>{{ runtimeEvidenceCount }}</strong>
        </div>
      </div>
      <div v-if="loadError" class="status-strip warning">
        <strong>读取不完整</strong>
        <span>{{ loadError }}</span>
      </div>
    </article>

    <section class="version-assembly-architecture">
      <div class="section-header version-assembly-section-header">
        <div>
          <h3>架构模块</h3>
          <p>按架构图层级组织，点击模块卡片展开功能项和下属组件。</p>
        </div>
        <StatusPill
          tone="info"
          :label="`${architectureLayerGroups.length} 层 / ${architectureItems.length} 个组件`"
        />
      </div>

      <div v-if="architectureLayerGroups.length === 0" class="version-assembly-empty">
        暂无架构组件
      </div>

      <section
        v-for="layer in architectureLayerGroups"
        :key="layer.layerId"
        class="surface-card version-assembly-layer"
        :data-layer="layer.layerId"
      >
        <div class="version-assembly-layer-header">
          <div>
            <span class="version-assembly-layer-kicker">{{ categoryLabel(layer.moduleCategory) }}</span>
            <h3>{{ layer.label }}</h3>
            <p>{{ layer.description }}</p>
          </div>
          <div class="version-assembly-layer-metrics" aria-label="层级装配统计">
            <span>{{ layer.selectedCount }} / {{ layer.componentCount }} 已选择</span>
            <span>{{ layer.hydratableCount }} 可脱水</span>
            <span>{{ layer.lockedCount }} 不可脱水</span>
          </div>
          <div class="version-assembly-card-actions">
            <button class="table-action" type="button" @click="setArchitectureLayerSelection(layer, true)">全选</button>
            <button class="table-action" type="button" @click="setArchitectureLayerSelection(layer, false)">清空</button>
          </div>
        </div>

        <div class="version-assembly-module-grid">
          <SplitToggleCard
            v-for="node in layer.roots"
            :key="node.componentId"
            as="article"
            class="version-assembly-module-card"
            :expanded="isModuleExpanded(node.componentId)"
            :expanded-label="`收起 ${node.label}`"
            :collapsed-label="`展开 ${node.label}`"
            @toggle="toggleModuleExpanded(node.componentId)"
          >
            <template #summary>
              <div class="version-assembly-module-summary">
                <div class="version-assembly-module-title">
                  <BinaryCheckbox
                    :model-value="isArchitectureSubtreeSelected(node)"
                    :label="node.label"
                    :disabled="architectureSubtreeToggleDisabled(node)"
                    @update:model-value="setArchitectureSubtreeSelection(node, $event)"
                  />
                  <p>{{ moduleSummaryText(node) }}</p>
                </div>
                <div class="version-assembly-module-meta">
                  <span class="version-assembly-hydration-chip" :data-hydratable="node.hydratable ? 'true' : 'false'">
                    {{ hydrationLabel(node.hydratable) }}
                  </span>
                  <span>{{ selectedArchitectureNodeCount(node) }} / {{ architectureNodeCount(node) }}</span>
                  <span>{{ hydratableArchitectureNodeCount(node) }} 可脱水</span>
                </div>
              </div>
            </template>

            <div class="version-assembly-module-body">
              <div v-if="node.functionItems.length" class="version-assembly-function-block">
                <strong>功能项</strong>
                <div class="version-assembly-function-list">
                  <span v-for="item in node.functionItems" :key="`${node.componentId}:${item}`">
                    {{ item }}
                  </span>
                </div>
              </div>

              <div v-if="node.children.length" class="version-assembly-child-tree">
                <strong>下属组件</strong>
                <div
                  v-for="child in flattenArchitectureChildren(node)"
                  :key="child.componentId"
                  class="version-assembly-tree-row"
                  :style="architectureTreeRowStyle(child)"
                >
                  <div class="version-assembly-tree-row-main">
                    <BinaryCheckbox
                      :model-value="isArchitectureComponentSelected(child)"
                      :label="child.label"
                      :disabled="!child.hydratable"
                      @update:model-value="setArchitectureComponentSelection(child, $event)"
                    />
                    <span class="version-assembly-hydration-chip" :data-hydratable="child.hydratable ? 'true' : 'false'">
                      {{ hydrationLabel(child.hydratable) }}
                    </span>
                  </div>
                  <p>{{ architectureChildDetail(child) }}</p>
                </div>
              </div>
            </div>
          </SplitToggleCard>
        </div>
      </section>
    </section>

    <details class="surface-card version-assembly-runtime-evidence">
      <summary class="version-assembly-evidence-summary">
        <div>
          <h3>运行态校验</h3>
          <p>只读证据：用于核对当前实例发现，不参与版本装配选择。</p>
        </div>
        <StatusPill tone="info" :label="`${runtimeEvidenceCount} 项发现`" />
        <span class="version-assembly-evidence-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 5L7 9L11 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </summary>

      <section class="version-assembly-runtime-grid">
        <article
          v-for="group in runtimeEvidenceGroups"
          :key="group.id"
          class="version-assembly-evidence-card"
        >
          <div class="section-header version-assembly-card-header">
            <div>
              <h3>{{ group.title }}</h3>
              <p>{{ group.items.length }} 项发现</p>
            </div>
          </div>
          <p class="version-assembly-card-description">{{ group.description }}</p>
          <div class="version-assembly-evidence-list">
            <div v-if="group.items.length === 0" class="version-assembly-empty">{{ group.emptyLabel }}</div>
            <div v-for="item in group.items" :key="item.id" class="version-assembly-evidence-row">
              <div>
                <strong>{{ item.label }}</strong>
                <p>{{ item.detail }}</p>
              </div>
              <span class="version-assembly-row-status">{{ item.statusLabel }}</span>
            </div>
          </div>
        </article>
      </section>
    </details>

    <article class="surface-card version-assembly-action-card">
      <div class="section-header">
        <div>
          <h3>装配输出</h3>
          <p>生成当前选择对应的运行时装配目录包，原运行时保持不变。</p>
        </div>
        <button
          class="primary-action"
          type="button"
          :disabled="!canBuildRuntimeAssembly"
          @click="buildRuntimeAssemblyPackage"
        >
          {{ buildingAssembly ? "生成中" : "生成装配目录包" }}
        </button>
      </div>
      <div v-if="assemblyError" class="status-strip danger">
        <strong>生成失败</strong>
        <span>{{ assemblyError }}</span>
      </div>
      <div v-else-if="assemblyArtifact" class="status-strip info version-assembly-artifact-strip">
        <strong>装配目录已生成</strong>
        <span>
          {{ assemblyArtifact.artifactRef }} · {{ assemblyArtifact.componentCount }} 个组件 ·
          {{ assemblyArtifact.portablePackageFileCount || 1 }} 个文件 ·
          {{ assemblyArtifact.portablePackageByteSize || assemblyArtifact.byteSize }} bytes
        </span>
      </div>
      <div v-else class="status-strip info">
        <strong>可生成</strong>
        <span>当前选择 {{ selectedArchitectureComponentIds.length }} 个架构组件，系统会自动纳入不可脱水基础组件。</span>
      </div>
    </article>
  </section>
</template>
