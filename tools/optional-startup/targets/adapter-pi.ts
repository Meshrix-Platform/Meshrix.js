import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:pi";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "pi",
    load: () : any => import(new URL("../../../plugins/agents/pi/adapter.mjs", import.meta.url).href),
  });
}
