import { onMounted, ref } from "vue";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import { createConsoleGatewayChannelController } from "./console-gateway-channel-controller";
import {
  getGatewayChannels,
  selectGatewayChannel,
  type GatewayChannelState
} from "../lib/gateway-channel-client";

export function useModulesViewConsole() {
  const gatewayChannelState = ref<GatewayChannelState | null>(null);
  const gatewayChannelBusy = ref(false);
  async function refreshGatewayChannels(): Promise<void> {
    gatewayChannelState.value = await getGatewayChannels();
  }
  const gatewayChannels = createConsoleGatewayChannelController(gatewayChannelState, {
    refresh: refreshGatewayChannels,
    async select(input): Promise<void> {
      gatewayChannelBusy.value = true;
      try {
        await selectGatewayChannel(input);
        await refreshGatewayChannels();
      } finally {
        gatewayChannelBusy.value = false;
      }
    }
  });
  onMounted(() => void refreshGatewayChannels());
  const {
  canBrowseServerPaths,
} = useServerConsoleShellContext().access;
const {
  disableMountModule,
  enableMountModule,
  enabledMountCount,
  moduleGroups,
  mountDraft,
  openMountPathPicker,
  reloadModules,
  saveMountModules,
  totalMountCount,
} = useServerConsoleShellContext().modules;
const {
  isBusy,
  consoleState,
} = useServerConsoleShellContext().runtime;

  return {
    isBusy,
    canBrowseServerPaths,
    consoleState,
    disableMountModule,
    enableMountModule,
    enabledMountCount,
    gatewayChannels,
    gatewayChannelBusy,
    moduleGroups,
    mountDraft,
    openMountPathPicker,
    reloadModules,
    saveMountModules,
    totalMountCount,
  };
}
