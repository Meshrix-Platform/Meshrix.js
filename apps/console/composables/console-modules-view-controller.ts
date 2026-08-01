import { onMounted, ref } from "vue";
import { useServerConsoleShellContext } from "./serverConsoleShellContext";
import { createConsoleExternalGatewayController, type ExternalGatewayState } from "./console-external-gateway-controller";
import { applyExternalGateway, getExternalGatewayState, switchExternalGatewayDirect } from "../lib/external-gateway-client";

export function useModulesViewConsole() : any {
  const externalGatewayState: any = ref<ExternalGatewayState | null>(null);
  const externalGatewayBusy: any = ref(false);
  async function refreshExternalGateway() : Promise<any> {
    externalGatewayState.value = await getExternalGatewayState();
  }
  const externalGateway: any = createConsoleExternalGatewayController(externalGatewayState, {
    refresh: refreshExternalGateway,
    async apply(input?: any) : Promise<any> {
      externalGatewayBusy.value = true;
      try {
        await applyExternalGateway(input);
        await refreshExternalGateway();
      } finally {
        externalGatewayBusy.value = false;
      }
    },
    async switchDirect(expectedGeneration?: any) : Promise<any> {
      externalGatewayBusy.value = true;
      try {
        await switchExternalGatewayDirect(expectedGeneration);
        await refreshExternalGateway();
      } finally {
        externalGatewayBusy.value = false;
      }
    },
  });
  onMounted(() : any => void refreshExternalGateway());
  const {
    busyKey,
    canBrowseServerPaths,
    consoleState,
    disableMountModule,
    enableMountModule,
    enabledMountCount,
    moduleGroups,
    mountDraft,
    openMountPathPicker,
    reloadModules,
    saveMountModules,
    totalMountCount,
  } = useServerConsoleShellContext();

  return {
    busyKey,
    canBrowseServerPaths,
    consoleState,
    disableMountModule,
    enableMountModule,
    enabledMountCount,
    externalGateway,
    externalGatewayBusy,
    moduleGroups,
    mountDraft,
    openMountPathPicker,
    reloadModules,
    saveMountModules,
    totalMountCount,
  };
}
