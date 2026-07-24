import { computed, reactive, ref } from "vue";

export type ConsoleCommandPaletteItem = {
  id: string;
  label: string;
  sectionLabel: string;
  keywords: string[];
  activate: () => void | Promise<unknown>;
};

export type ConsoleNavMessages = {
  nav: Record<string, string>;
};

/** 导航分区（registry section）到本地化标签的解析；primary 返回空串表示无分区。 */
export function resolveAdminSectionLabel(section: string, messages: ConsoleNavMessages): string {
  switch (section) {
    case "agent":
      return messages.nav.agents;
    case "integration":
      return messages.nav.integrations;
    case "operationPermission":
      return messages.nav.agentTools;
    case "system":
      return messages.nav.system;
    case "operations":
      return messages.nav.operations;
    case "version":
      return messages.nav.version;
    default:
      return "";
  }
}

/** admin viewKey 到导航标签的解析，与侧边栏的标签来源保持一致。 */
export function resolveAdminViewLabel(viewKey: string, messages: ConsoleNavMessages): string {
  if (viewKey === "storage") {
    return messages.nav.overview;
  }
  return messages.nav[viewKey] || viewKey;
}

const state = reactive({
  open: false,
});

const query = ref("");
const activeIndex = ref(0);

export function openConsoleCommandPalette() {
  state.open = true;
  query.value = "";
  activeIndex.value = 0;
}

export function closeConsoleCommandPalette() {
  state.open = false;
}

export function toggleConsoleCommandPalette() {
  if (state.open) {
    closeConsoleCommandPalette();
    return;
  }
  openConsoleCommandPalette();
}

export function filterConsoleCommandPaletteItems(
  items: ConsoleCommandPaletteItem[],
  rawQuery: string,
): ConsoleCommandPaletteItem[] {
  const normalized = rawQuery.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.filter((item) =>
    [item.label, item.sectionLabel, ...item.keywords].some(
      (text) => text && text.toLowerCase().includes(normalized),
    ),
  );
}

/** 按分区合并为唯一分组，保留首次出现顺序；分组 key 唯一，供列表渲染。 */
export function groupConsoleCommandPaletteItems(
  items: ConsoleCommandPaletteItem[],
): { sectionLabel: string; items: ConsoleCommandPaletteItem[] }[] {
  const groups = new Map<string, ConsoleCommandPaletteItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.sectionLabel);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.sectionLabel, [item]);
    }
  }
  return [...groups.entries()].map(([sectionLabel, groupItems]) => ({
    sectionLabel,
    items: groupItems,
  }));
}

export function useConsoleCommandPalette() {
  return {
    paletteOpen: computed(() => state.open),
    query,
    activeIndex,
    openPalette: openConsoleCommandPalette,
    closePalette: closeConsoleCommandPalette,
    togglePalette: toggleConsoleCommandPalette,
  };
}
