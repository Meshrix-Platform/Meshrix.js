import { computed, type Ref } from "vue";
import type { ConsoleAuthSummary } from "../lib/auth-types";
import type { OptionBarOption } from "../types/app";

export function createConsoleOptionBarController(options: { authState: Ref<ConsoleAuthSummary | null> }) {
  const authRoleOptionBarOptions = computed<OptionBarOption[]>(() =>
    (options.authState.value?.roles || []).map((role) => ({ value: role.roleId, label: role.label }))
  );
  return { authRoleOptionBarOptions };
}
