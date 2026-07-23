import { computed, ref, watch, type Ref } from "vue";

export type ExternalGatewayMode = "direct" | "external";
export type ExternalGatewayAdapterId = "caddy" | "nginx";

export type ExternalGatewayState = {
  mode: ExternalGatewayMode;
  adapterId?: ExternalGatewayAdapterId;
  generation: number;
  availableAdapters: Array<{ adapterId: ExternalGatewayAdapterId; label: string }>;
  profile?: { gatewayMode?: { publicBaseUrl?: string } };
};

export function createConsoleExternalGatewayController(
  state: Ref<ExternalGatewayState | null>,
  actions: {
    refresh?: () => Promise<unknown>;
    apply?: (input: {
      expectedGeneration: number;
      mode: "external";
      adapterId: ExternalGatewayAdapterId;
      publicBaseUrl: string;
    }) => Promise<unknown>;
    switchDirect?: (expectedGeneration: number) => Promise<unknown>;
  } = {},
) {
  const modeDraft = ref<ExternalGatewayMode>("direct");
  const adapterDraft = ref<ExternalGatewayAdapterId>("caddy");
  const publicBaseUrlDraft = ref("");
  watch(state, (next) => {
    if (next?.adapterId) adapterDraft.value = next.adapterId;
    publicBaseUrlDraft.value = String(next?.profile?.gatewayMode?.publicBaseUrl || "");
  }, { immediate: true });

  return {
    modeDraft,
    adapterDraft,
    publicBaseUrlDraft,
    activeMode: computed(() => state.value?.mode || "direct"),
    activeAdapter: computed(() => state.value?.adapterId || "caddy"),
    availableAdapters: computed(() => state.value?.availableAdapters || []),
    generation: computed(() => state.value?.generation || 0),
    refresh: actions.refresh || (async () => undefined),
    apply: actions.apply || (async () => undefined),
    switchDirect: actions.switchDirect || (async () => undefined),
  };
}
