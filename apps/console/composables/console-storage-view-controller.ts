import { computed } from "vue";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";

export function useStorageViewConsole() : any {
  const {
  currentUser,
  logoutConsole,
} = useServerConsoleShellContext().access;
const {
  openAdmin,
} = useServerConsoleShellContext().navigation;
const {
  enabledMountCount,
  totalMountCount,
} = useServerConsoleShellContext().modules;
const {
  openDrawer,
} = useServerConsoleShellContext().overlays;
const {
  isBusy,
  consoleState,
} = useServerConsoleShellContext().runtime;

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
