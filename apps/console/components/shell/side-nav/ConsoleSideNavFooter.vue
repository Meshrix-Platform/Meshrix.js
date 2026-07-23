<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";

defineOptions({ name: "ConsoleSideNavFooter" });

const {
  appearanceCycleScheme,
  appearanceCycleSchemeLabel,
  appearancePresetLabel,
  cycleAppearancePreset,
  languageMode,
  msg,
  openDrawer,
  sideNavOpen,
  toggleAppearanceCycleScheme,
  toggleLanguage,
  tt,
} = useConsoleSideNavContext();

const globalSettingsLabel = computed(() => tt("全局设置"));
const languageToggleLabel = computed(() => tt("切换语言"));
const languageShortLabel = computed(() => (languageMode.value === "en" ? "EN" : "中"));
const appearanceToggleTitle = computed(() =>
  `${msg.value.topbar.appearancePresetTitle}: ${appearancePresetLabel.value}`
);
const appearanceToggleLabel = computed(() =>
  `${msg.value.topbar.appearancePresetLabel}: ${appearancePresetLabel.value}`
);
const appearanceCycleSchemeTitle = computed(() =>
  appearanceCycleScheme.value === "dark"
    ? msg.value.topbar.appearanceCycleSchemeDarkTitle
    : msg.value.topbar.appearanceCycleSchemeLightTitle
);

function openPreferences() {
  sideNavOpen.value = false;
  openDrawer("preferences");
}

</script>

<template>
  <div class="side-nav-footer">
    <div class="side-nav-global-actions" role="group" :aria-label="globalSettingsLabel">
      <button
        class="side-global-action"
        type="button"
        :title="appearanceCycleSchemeTitle"
        :aria-label="appearanceCycleSchemeLabel"
        @click="toggleAppearanceCycleScheme"
      >
        <svg
          v-if="appearanceCycleScheme === 'dark'"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20.5 14.5A7.6 7.6 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
        </svg>
        <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      </button>
      <button
        class="side-global-action"
        type="button"
        :title="appearanceToggleTitle"
        :aria-label="appearanceToggleLabel"
        @click="cycleAppearancePreset"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 22a10 10 0 1 1 10-10 3 3 0 0 1-3 3h-2.5a2.5 2.5 0 0 0-2 4l.5.67A1.5 1.5 0 0 1 13.8 22H12Z" />
          <circle cx="8.5" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="10.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="6.5" cy="12.5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button
        class="side-global-action side-global-action-language"
        type="button"
        :title="languageToggleLabel"
        :aria-label="languageToggleLabel"
        @click="toggleLanguage"
      >
        <span class="side-global-action-glyph" aria-hidden="true">{{ languageShortLabel }}</span>
      </button>
    </div>
    <button
      class="side-cta"
      type="button"
      :aria-label="msg.nav.systemConfig"
      :title="msg.nav.systemConfig"
      @click="openPreferences"
    >
      <svg
        class="side-cta-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.52a2 2 0 0 1-1 1.72l-.15.1a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.52a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span class="side-cta-label">{{ msg.nav.systemConfig }}</span>
    </button>
  </div>
</template>
