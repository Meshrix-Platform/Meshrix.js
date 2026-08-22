import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:claude-code";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "claude-code",
    load: () : any => import(new URL("../../../plugins/agents/claude-code/adapter.mjs", import.meta.url).href),
  });
}
