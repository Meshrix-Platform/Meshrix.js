import { ref, watch, type Ref } from "vue";
import { saveDiscoveryConfig } from "../lib/discovery-client";
import type { DiscoveryConfig } from "../lib/types";
import type { RefreshStateOptions } from "../types/app";
import { emptyDiscovery } from "./console-defaults";

type ConsoleDiscoveryControllerOptions = {
  applyRemoteConsoleDraftUpdate: (update: () => void) => void;
  clearAllBusy: () => void;
  error: Ref<string>;
  isApplyingRemoteConsoleDrafts: () => boolean;
  refreshState: (options?: RefreshStateOptions) => Promise<unknown>;
  remoteDraftEquals: (left: unknown, right: unknown) => boolean;
  setBusy: (key: string) => void;
};

export function createConsoleDiscoveryController(
  options: ConsoleDiscoveryControllerOptions,
) {
  const discoveryDraft = ref<DiscoveryConfig>({ ...emptyDiscovery });
  const discoveryDraftDirty = ref(false);

  watch(
    discoveryDraft,
    () => {
      if (!options.isApplyingRemoteConsoleDrafts()) {
        discoveryDraftDirty.value = true;
      }
    },
    { deep: true, flush: "sync" },
  );

  function replaceDiscoveryDraftFromServer(
    value: Partial<DiscoveryConfig> | null | undefined,
    replaceOptions: { markClean?: boolean } = {},
  ) {
    const nextDraft = {
      ...emptyDiscovery,
      ...(value || {}),
    };
    if (options.remoteDraftEquals(discoveryDraft.value, nextDraft)) {
      if (replaceOptions.markClean !== false) {
        discoveryDraftDirty.value = false;
      }
      return;
    }
    options.applyRemoteConsoleDraftUpdate(() => {
      discoveryDraft.value = nextDraft;
      if (replaceOptions.markClean !== false) {
        discoveryDraftDirty.value = false;
      }
    });
  }

  async function saveDiscovery() {
    options.setBusy("discovery");
    options.error.value = "";

    try {
      await saveDiscoveryConfig(discoveryDraft.value);
      discoveryDraftDirty.value = false;
      await options.refreshState({ forceDrafts: false });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "保存服务发现配置失败。";
      options.clearAllBusy();
    }
  }

  return {
    discoveryDraft,
    discoveryDraftDirty,
    replaceDiscoveryDraftFromServer,
    saveDiscovery,
  };
}
