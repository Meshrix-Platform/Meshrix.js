import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:openclaw";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "openclaw",
    load: () : any => import(new URL("../../../plugins/agents/openclaw/adapter.mjs", import.meta.url).href),
  });
}
