import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:kimi";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "kimi",
    load: () : any => import(new URL("../../../plugins/agents/kimi/adapter.mjs", import.meta.url).href),
  });
}
