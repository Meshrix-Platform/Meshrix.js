export const OPTIONAL_STARTUP_TARGET_ID: any = "plugin:shared-space";

export async function startOptionalTarget() : Promise<any> {
  return Object.freeze({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "plugin",
    status: "selected",
    pluginId: "shared-space",
  });
}
