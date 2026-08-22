export const OPTIONAL_STARTUP_TARGET_ID: any = "plugin:model-gateway";

export async function startOptionalTarget() : Promise<any> {
  return Object.freeze({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "plugin",
    status: "selected",
    pluginId: "model-gateway",
  });
}
