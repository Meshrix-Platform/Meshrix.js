import { computed } from "vue";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

export function useStorageViewConsole() : any {
  const {
    isBusy,
    consoleState,
    currentUser,
    enabledMountCount,
    logoutConsole,
    openAdmin,
    openDrawer,
    totalMountCount,
  } = useServerConsoleShellContext();

  const enabledMountPercent: any = computed(() : any =>
    totalMountCount.value ? (enabledMountCount.value / totalMountCount.value) * 100 : 0,
  );

  return {
    isBusy,
    consoleState,
    currentUser,
    enabledMountCount,
    enabledMountPercent,
    logoutConsole,
    openAdmin,
    openDrawer,
    totalMountCount,
  };
}
