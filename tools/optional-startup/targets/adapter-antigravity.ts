import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:antigravity";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "antigravity",
    load: () : any => import(new URL("../../../plugins/agents/antigravity/adapter.mjs", import.meta.url).href),
  });
}
