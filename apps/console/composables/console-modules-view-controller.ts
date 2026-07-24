import { onMounted, ref } from "vue";
import { useServerConsoleShellContext } from "./serverConsoleShellContext";
import { createConsoleExternalGatewayController, type ExternalGatewayState } from "./console-external-gateway-controller";
import { applyExternalGateway, getExternalGatewayState, switchExternalGatewayDirect } from "../lib/external-gateway-client";

export function useModulesViewConsole() {
  const externalGatewayState = ref<ExternalGatewayState | null>(null);
  const externalGatewayBusy = ref(false);
  async function refreshExternalGateway() {
    externalGatewayState.value = await getExternalGatewayState();
  }
  const externalGateway = createConsoleExternalGatewayController(externalGatewayState, {
    refresh: refreshExternalGateway,
    async apply(input) {
      externalGatewayBusy.value = true;
      try {
        await applyExternalGateway(input);
        await refreshExternalGateway();
      } finally {
        externalGatewayBusy.value = false;
      }
    },
    async switchDirect(expectedGeneration) {
      externalGatewayBusy.value = true;
      try {
        await switchExternalGatewayDirect(expectedGeneration);
        await refreshExternalGateway();
      } finally {
        externalGatewayBusy.value = false;
      }
    },
  });
  onMounted(() => void refreshExternalGateway());
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
