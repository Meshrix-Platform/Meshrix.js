<script setup lang="ts">
import { ref } from "vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import type { OptionBarModelValue, OptionBarValue } from "../../types/app";

const {
  appearancePresetCatalogMessage,
  appearancePresetImporting,
  appearanceCycleScheme,
  appearanceCycleSchemeOptions,
  appearancePresetOptionsForCycleScheme,
  appearancePresetSelectionId,
  importAppearancePresetFileToServer,
  refreshAppearancePresetConfigs,
  languageMode,
  languageOptionBarOptions,
  msg,
  setAppearanceCycleScheme,
  setAppearancePreset,
  setLanguage,
} = useServerConsoleShellContext().preferences;

const appearancePresetFileInputRef = ref<HTMLInputElement | null>(null);

function scalarOptionValue(value: OptionBarModelValue): OptionBarValue {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

function updateLanguage(value: OptionBarModelValue) {
  setLanguage(scalarOptionValue(value));
}

function updateAppearanceCycleScheme(value: OptionBarModelValue) {
  setAppearanceCycleScheme(scalarOptionValue(value));
}

function updateAppearancePreset(value: OptionBarModelValue) {
  setAppearancePreset(scalarOptionValue(value));
}

async function handleAppearancePresetFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    await importAppearancePresetFileToServer(file);
  }
  input.value = "";
}
</script>

<template>
  <section class="drawer-panel">
    <div class="panel-header">
      <h4>{{ msg.drawer.preferencesTitle }}</h4>
      <p>{{ msg.drawer.preferencesDescription }}</p>
    </div>
    <section class="module-panel">
      <div class="module-panel-heading">
        <strong>{{ msg.drawer.language }}</strong>
      </div>
      <OptionBar
        :model-value="languageMode"
        :options="languageOptionBarOptions"
        @update:model-value="updateLanguage"
      />
    </section>
    <section class="module-panel">
      <div class="module-panel-heading">
        <strong>{{ msg.drawer.appearancePreset }}</strong>
      </div>
      <OptionBar
        :model-value="appearanceCycleScheme"
        :label="msg.drawer.theme"
        :options="appearanceCycleSchemeOptions"
        @update:model-value="updateAppearanceCycleScheme"
      />
      <OptionBar
        :model-value="appearancePresetSelectionId"
        :label="msg.drawer.appearancePreset"
        :options="appearancePresetOptionsForCycleScheme"
        @update:model-value="updateAppearancePreset"
      />
      <div class="drawer-inline-actions">
        <button
          class="tool-button tool-button-ghost"
          type="button"
          :disabled="appearancePresetImporting"
          @click="appearancePresetFileInputRef?.click()"
        >
          {{ msg.drawer.importAppearancePresetToServer }}
        </button>
        <button class="tool-button tool-button-ghost" type="button" @click="refreshAppearancePresetConfigs()">
          {{ msg.drawer.reloadAppearancePresets }}
        </button>
        <input
          ref="appearancePresetFileInputRef"
          type="file"
          accept="application/json,.json"
          hidden
          @change="handleAppearancePresetFileChange"
        />
      </div>
      <p v-if="appearancePresetCatalogMessage" class="panel-note">{{ appearancePresetCatalogMessage }}</p>
    </section>
  </section>
</template>
