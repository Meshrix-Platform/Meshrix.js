import { computed } from "vue";
import { useServerConsoleShellContext } from "./serverConsoleShellContext";

export function useStorageViewConsole() {
  const {
    busyKey,
    consoleState,
    currentUser,
    enabledMountCount,
    logoutConsole,
    openAdmin,
    openDrawer,
    totalMountCount,
  } = useServerConsoleShellContext();

  const enabledMountPercent = computed(() =>
    totalMountCount.value ? (enabledMountCount.value / totalMountCount.value) * 100 : 0,
  );

  return {
    busyKey,
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
