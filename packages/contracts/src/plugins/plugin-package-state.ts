export const PLUGIN_PACKAGE_STATES: readonly any[] = Object.freeze([
  "declared",
  "acquiring",
  "acquired",
  "verified",
  "staged",
  "active",
  "failed",
  "disabled",
  "rolled-back",
  "removed"
]);

const PLUGIN_PACKAGE_STATE_SET: any = new Set<any>(PLUGIN_PACKAGE_STATES);

const TRANSITIONS: Readonly<Record<string, any>> = Object.freeze({
  declared: Object.freeze(["acquiring", "failed", "removed"]),
  acquiring: Object.freeze(["acquired", "failed", "removed"]),
  acquired: Object.freeze(["verified", "failed", "removed"]),
  verified: Object.freeze(["staged", "failed", "disabled", "removed"]),
  staged: Object.freeze(["active", "failed", "rolled-back", "disabled", "removed"]),
  active: Object.freeze(["disabled", "rolled-back", "failed", "removed"]),
  failed: Object.freeze(["declared", "acquiring", "removed", "disabled", "rolled-back"]),
  disabled: Object.freeze(["verified", "acquiring", "removed"]),
  "rolled-back": Object.freeze(["verified", "acquiring", "disabled", "removed"]),
  removed: Object.freeze([])
});

export function isPluginPackageState(value?: any) : any {
  return typeof value === "string" && PLUGIN_PACKAGE_STATE_SET.has(value);
}

export function assertPluginPackageTransition(from?: any, to?: any, event: any = "transition") : any {
  if (!isPluginPackageState(from)) {
    throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: unknown from-state for ${event}`);
  }
  if (!isPluginPackageState(to)) {
    throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: unknown to-state for ${event}`);
  }
  const allowed: any = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`PLUGIN_PACKAGE_STATE_INVALID: ${from} cannot move to ${to} (${event})`);
  }
  return true;
}

export function listPluginPackageTransitions(from?: any) : any {
  if (!isPluginPackageState(from)) return Object.freeze([]);
  return TRANSITIONS[from];
}
