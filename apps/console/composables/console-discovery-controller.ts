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
) : any {
  const discoveryDraft: any = ref<DiscoveryConfig>({ ...emptyDiscovery });
  const discoveryDraftDirty: any = ref(false);

  watch(
    discoveryDraft,
    () : any => {
      if (!options.isApplyingRemoteConsoleDrafts()) {
        discoveryDraftDirty.value = true;
      }
    },
    { deep: true, flush: "sync" },
  );

  function replaceDiscoveryDraftFromServer(
    value: Partial<DiscoveryConfig> | null | undefined,
    replaceOptions: { markClean?: boolean } = {},
  ) : any {
    const nextDraft: Record<string, any> = {
      ...emptyDiscovery,
      ...(value || {}),
    };
    if (options.remoteDraftEquals(discoveryDraft.value, nextDraft)) {
      if (replaceOptions.markClean !== false) {
        discoveryDraftDirty.value = false;
      }
      return;
    }
    options.applyRemoteConsoleDraftUpdate(() : any => {
      discoveryDraft.value = nextDraft;
      if (replaceOptions.markClean !== false) {
        discoveryDraftDirty.value = false;
      }
    });
  }

  async function saveDiscovery() : Promise<any> {
    options.setBusy("discovery");
    options.error.value = "";

    try {
      await saveDiscoveryConfig(discoveryDraft.value);
      discoveryDraftDirty.value = false;
      await options.refreshState({ forceDrafts: false });
    } catch (nextError: any) {
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
