<script setup lang="ts">
import { normalizeServerAddressUrl } from "../../../lib/console-server-addresses";
import type { ServerAddressRow } from "./types";

defineOptions({ name: "ConsoleServerAddressRow" });

const props = withDefaults(
  defineProps<{
    row: ServerAddressRow;
    index?: number;
    selected?: boolean;
  }>(),
  {
    index: 0,
    selected: false,
  },
);

const emit = defineEmits<{
  select: [row: ServerAddressRow];
  urlInput: [row: ServerAddressRow, value: string];
  validate: [row: ServerAddressRow];
  add: [];
  remove: [row: ServerAddressRow];
}>();

function canSwitchServerAddress() {
  if (props.selected) {
    return true;
  }
  return props.row.validationStatus === "available" && Boolean(normalizeServerAddressUrl(props.row.url));
}

function switchButtonTitle() {
  if (props.selected) {
    return "当前绑定";
  }
  if (!normalizeServerAddressUrl(props.row.url)) {
    return "请输入有效的服务端地址";
  }
  if (props.row.validationStatus !== "available") {
    return "验证通过后才能切换";
  }
  return "切换到此服务端地址";
}

function validationStatusLabel() {
  if (props.row.validationStatus === "checking") {
    return "验证中";
  }
  if (props.row.validationStatus === "available") {
    return "可用";
  }
  if (props.row.validationStatus === "unavailable") {
    return "不可用";
  }
  return "未验证";
}

function validationStatusTone() {
  if (props.row.validationStatus === "available") {
    return "success";
  }
  if (props.row.validationStatus === "unavailable") {
    return "danger";
  }
  if (props.row.validationStatus === "checking") {
    return "warning";
  }
  return "neutral";
}

function handleUrlInput(event: Event) {
  emit("urlInput", props.row, (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div
    class="server-address-row"
    :class="{ 'is-selected': selected }"
  >
    <button
      class="server-address-icon-button server-address-switch-button"
      type="button"
      :class="{ active: selected }"
      :disabled="!canSwitchServerAddress()"
      :title="switchButtonTitle()"
      :aria-label="switchButtonTitle()"
      @click="emit('select', row)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4 4 10-10" />
      </svg>
    </button>

    <div class="server-address-input-wrap">
      <input
        :value="row.url"
        autocomplete="off"
        placeholder="http://127.0.0.1:7228"
        @input="handleUrlInput"
      />
      <span
        class="server-address-status-pill"
        :data-tone="validationStatusTone()"
      >
        {{ validationStatusLabel() }}
      </span>
    </div>

    <button
      class="server-address-validate-button"
      type="button"
      :disabled="row.validationStatus === 'checking' || !row.url.trim()"
      @click="emit('validate', row)"
    >
      {{ row.validationStatus === "checking" ? "验证中" : "验证" }}
    </button>

    <button
      v-if="index === 0"
      class="server-address-icon-button server-url-add-button"
      type="button"
      title="添加服务端地址"
      aria-label="添加服务端地址"
      @click="emit('add')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    </button>
    <button
      v-else
      class="server-address-icon-button server-url-remove-button"
      type="button"
      title="删除服务端地址"
      aria-label="删除服务端地址"
      @click="emit('remove', row)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12h14" />
      </svg>
    </button>

    <p v-if="row.validationMessage" class="server-address-row-message">
      {{ row.validationMessage }}
    </p>
  </div>
</template>

<style scoped>
.server-address-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 64px 36px;
  gap: var(--space-2);
  align-items: center;
}

.server-address-input-wrap {
  position: relative;
  min-width: 0;
}

.server-address-input-wrap input {
  width: 100%;
  min-width: 0;
  padding-right: 72px;
}

.server-address-icon-button,
.server-address-validate-button {
  min-height: 36px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-weight: 700;
  transition:
    background var(--dur-fast) var(--ease-std),
    border-color var(--dur-fast) var(--ease-std),
    color var(--dur-fast) var(--ease-std),
    transform var(--dur-fast) var(--ease-std),
    box-shadow var(--dur-fast) var(--ease-std);
}

.server-address-icon-button {
  display: inline-flex;
  width: 36px;
  min-width: 36px;
  padding: 0;
  align-items: center;
  justify-content: center;
}

.server-address-icon-button svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.server-address-icon-button:hover,
.server-address-validate-button:hover {
  border-color: var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
}

.server-address-icon-button.active {
  border-color: var(--brand);
  background: var(--brand-subtle);
  color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-ring);
}

.server-url-remove-button:hover {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger);
}

.server-address-icon-button:disabled,
.server-address-validate-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.server-address-status-pill {
  position: absolute;
  top: 50%;
  right: 10px;
  display: inline-flex;
  min-width: 54px;
  min-height: 22px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
  transform: translateY(-50%);
  pointer-events: none;
}

.server-address-status-pill[data-tone="success"] {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success);
}

.server-address-status-pill[data-tone="danger"] {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger);
}

.server-address-status-pill[data-tone="warning"] {
  border-color: var(--warning-border);
  background: var(--warning-surface);
  color: var(--warning);
}

.server-address-row-message {
  grid-column: 2 / -1;
  margin: -2px 0 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-snug);
}

@media (max-width: 760px) {
  .server-address-row {
    grid-template-columns: 36px minmax(0, 1fr) 36px;
  }

  .server-address-validate-button {
    grid-column: 2 / 3;
    justify-self: start;
    width: 78px;
  }

  .server-url-add-button,
  .server-url-remove-button {
    grid-column: 3 / 4;
    grid-row: 1 / 2;
  }
}
</style>
