import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:opencode";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "opencode",
    load: () : any => import(new URL("../../../plugins/agents/opencode/adapter.mjs", import.meta.url).href),
  });
}
