import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import type {
  GatewayChannelState,
  GatewayDirection
} from "../lib/gateway-channel-client";

export interface GatewayChannelDirectionController {
  readonly draft: Ref<string>;
  readonly available: ComputedRef<string[]>;
  readonly selected: ComputedRef<string>;
  readonly generation: ComputedRef<number>;
  readonly changed: ComputedRef<boolean>;
  readonly select: (input: {
    direction: GatewayDirection;
    channelId: string;
    expectedGeneration: number;
  }) => Promise<unknown>;
}

export interface ConsoleGatewayChannelController {
  readonly downstream: GatewayChannelDirectionController;
  readonly upstream: GatewayChannelDirectionController;
  readonly refresh: () => Promise<unknown>;
}

export function createConsoleGatewayChannelController(
  state: Ref<GatewayChannelState | null>,
  actions: {
    refresh?: () => Promise<unknown>;
    select?: (input: { direction: GatewayDirection; channelId: string; expectedGeneration: number }) => Promise<unknown>;
  } = {}
): ConsoleGatewayChannelController {
  const drafts: Record<GatewayDirection, Ref<string>> = {
    downstream: ref(""),
    upstream: ref("")
  };
  watch(state, (next) => {
    for (const direction of ["downstream", "upstream"] as const) {
      const selected = next?.selections?.[direction]?.channelId || "";
      const choices = next?.available?.[direction] || [];
      if (!choices.includes(drafts[direction].value)) drafts[direction].value = selected;
    }
  }, { immediate: true });

  function direction(direction: GatewayDirection): GatewayChannelDirectionController {
    return Object.freeze({
      draft: drafts[direction],
      available: computed(() => state.value?.available?.[direction] || []),
      selected: computed(() => state.value?.selections?.[direction]?.channelId || ""),
      generation: computed(() => state.value?.selections?.[direction]?.generation || 0),
      changed: computed(() => Boolean(drafts[direction].value) &&
        drafts[direction].value !== state.value?.selections?.[direction]?.channelId),
      select: actions.select || (async () => undefined)
    });
  }

  return Object.freeze({
    downstream: direction("downstream"),
    upstream: direction("upstream"),
    refresh: actions.refresh || (async () => undefined)
  });
}
