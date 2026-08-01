export const CONSOLE_COMPOSITION_SOURCE_PATH: any = "apps/console/composables/useConsole.ts";

export const CONSOLE_COMPOSITION_REQUIRED_TOKENS: readonly any[] = Object.freeze([
  "createConsoleBusyController",
  "createConsoleAuthController",
  "createConsoleServerEventController",
  "createConsoleRefreshStateController",
  "createConsoleRuntimeLifecycleController",
  "createConsoleSettingsBridgeController",
  "createConsoleSettingsDraftController",
  "createConsoleSettingsPersistenceController",
  "createConsoleModelLibraryController",
  "createConsoleAgentSelectorController",
  "createConsoleOperationPermissionController",
  "createConsoleClientController",
  "createConsoleJobController",
  "createConsoleOpsMonitorController",
  "createConsoleMaintenanceAgentController",
  "createConsoleContextCompilerController",
  "createConsolePathPickerController",
  "createConsoleRuntimeMountController",
  "createConsoleDiscoveryController",
  "createConsoleSystemLogRowController",
  "createConsoleSystemLogController",
  "createConsoleDashboardAlertController",
  "firstAccessibleRoutePath",
  "satisfies ConsoleController"
]);

export const CONSOLE_COMPOSITION_FORBIDDEN_PATTERNS: readonly any[] = Object.freeze([
  { id: "async-noop", label: "asyncNoop", pattern: /\basyncNoop\b/u },
  { id: "dynamic-default-value", label: "defaultValueForKey", pattern: /\bdefaultValueForKey\b/u },
  { id: "dynamic-defaults", label: "dynamicDefaults", pattern: /\bdynamicDefaults\b/u },
  { id: "proxy-fallback", label: "new Proxy", pattern: /\bnew\s+Proxy\s*\(/u },
  { id: "untyped-index-signature", label: "[key: string]: any", pattern: /\[\s*key\s*:\s*string\s*\]\s*:\s*any\b/u },
  { id: "generic-noop", label: "function noop", pattern: /\bfunction\s+noop\s*\(/u }
]);
