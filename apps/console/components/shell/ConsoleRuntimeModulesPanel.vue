<script setup lang="ts">
import BrowseSelectButton from "../BrowseSelectButton.vue";
import ConsoleDescriptionList from "../ConsoleDescriptionList.vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import {
  currentModulePathPlaceholder,
  moduleAvailabilityLabel,
  moduleCapabilityText,
  moduleStatusText,
  type RuntimeModuleRow,
} from "../../composables/console-runtime-module-display-utils";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

import { currentConsoleLocale, localizeConsoleText } from "../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const {
  isBusy,
  canBrowseServerPaths,
  consoleState,
  enabledMountCount,
  isMountPathEditing,
  moduleGroups,
  mountDraft,
  openMountPathPicker,
  reloadModules,
  saveMountModules,
  toggleMountPathEdit,
  totalMountCount,
} = useServerConsoleShellContext();

function moduleDetailItems(item: RuntimeModuleRow) {
  return [
    { label: "运行实例", value: item.runtimeMount?.id || "未加载" },
    { label: "能力", value: moduleCapabilityText(item) },
    { label: "运行状态", value: moduleStatusText(item) },
  ];
}
</script>

<template>
  <section class="drawer-panel">
    <div class="panel-header">
      <h4>模块管理</h4>
      <p>运行代次 {{ consoleState?.runtime?.mountGeneration || 0 }}，可用 {{ enabledMountCount }}/{{ totalMountCount }}</p>
    </div>

    <div class="drawer-actions">
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

    <section
      v-for="group in moduleGroups"
      :key="group.id"
      class="module-panel"
    >
      <div class="module-panel-heading">
        <strong>{{ group.label }}</strong>
        <span>{{ group.description }}</span>
      </div>

      <article
        v-for="item in group.rows"
        :key="item.name"
        class="mount-config-item drawer-mount-item"
        :data-enabled="item.externalEnabled"
      >
        <div class="mount-config-heading">
          <strong>{{ item.label }}</strong>
          <StatusPill
            :enabled="item.externalEnabled"
            :label="localizeStatusPillLabel(moduleAvailabilityLabel(item))"
          />
        </div>
        <p class="mount-config-description">{{ item.description }}</p>
        <ConsoleDescriptionList :items="moduleDetailItems(item)" />

        <div class="mount-config-controls">
          <label class="module-field">
            <span>模块路径</span>
            <div class="path-field">
              <input
                v-model="mountDraft[item.name]"
                autocomplete="off"
                :disabled="!isMountPathEditing(item.name)"
                :placeholder="currentModulePathPlaceholder(item)"
              />
              <BrowseSelectButton
                kind="server-file"
                button-class="path-action-button"
                button-text="浏览"
                size="small"
                :disabled="!canBrowseServerPaths"
                plain
                @browse="openMountPathPicker(item.name)"
              />
            </div>
          </label>
          <button
            class="tool-button tool-button-ghost compact-action"
            type="button"
            :disabled="isBusy(`mount:${item.name}`)"
            :aria-busy="isBusy(`mount:${item.name}`)"
            @click="toggleMountPathEdit(item)"
          >
            {{ isMountPathEditing(item.name) ? "确认" : "修改" }}
          </button>
        </div>
      </article>
    </section>
  </section>
</template>
