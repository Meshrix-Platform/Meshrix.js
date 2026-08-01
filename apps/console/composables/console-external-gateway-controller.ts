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
) : any {
  const modeDraft: any = ref<ExternalGatewayMode>("direct");
  const adapterDraft: any = ref<ExternalGatewayAdapterId>("caddy");
  const publicBaseUrlDraft: any = ref("");
  watch(state, (next?: any) : any => {
    if (next?.adapterId) adapterDraft.value = next.adapterId;
    publicBaseUrlDraft.value = String(next?.profile?.gatewayMode?.publicBaseUrl || "");
  }, { immediate: true });

  return {
    modeDraft,
    adapterDraft,
    publicBaseUrlDraft,
    activeMode: computed(() : any => state.value?.mode || "direct"),
    activeAdapter: computed(() : any => state.value?.adapterId || "caddy"),
    availableAdapters: computed(() : any => state.value?.availableAdapters || []),
    generation: computed(() : any => state.value?.generation || 0),
    refresh: actions.refresh || (async () : Promise<any> => undefined),
    apply: actions.apply || (async () : Promise<any> => undefined),
    switchDirect: actions.switchDirect || (async () : Promise<any> => undefined),
  };
}
