<script setup lang="ts">
defineOptions({ name: "ConsoleSideNavLink" });

const props = withDefaults(defineProps<{
  active?: boolean;
  href?: string;
  label: string;
  subtle?: boolean;
}>(), {
  active: false,
  href: "",
  subtle: false,
});

const emit = defineEmits<{
  activate: [];
}>();

function handleAnchorClick(event: MouseEvent) {
  // 修饰键/中键点击交给浏览器原生新标签行为；普通点击保持 SPA 跳转与调用方副作用。
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  emit("activate");
}
</script>

<template>
  <a
    v-if="props.href"
    class="side-link"
    :class="{ active: props.active, 'side-link-subtle': props.subtle }"
    :href="props.href"
    :aria-label="label"
    :aria-current="props.active ? 'page' : undefined"
    @click="handleAnchorClick"
  >
    <slot name="icon"></slot>
    <span class="side-link-label">{{ label }}</span>
    <slot name="trail"></slot>
  </a>
  <button
    v-else
    class="side-link"
    :class="{ active: props.active, 'side-link-subtle': props.subtle }"
    type="button"
    :aria-label="label"
    @click="emit('activate')"
  >
    <slot name="icon"></slot>
    <span class="side-link-label">{{ label }}</span>
    <slot name="trail"></slot>
  </button>
</template>

<style scoped>
a.side-link {
  appearance: none;
  border: none;
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-decoration: none;
  width: 100%;
}
</style>
